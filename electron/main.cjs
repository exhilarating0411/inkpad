/**
 * NeatNotes for Windows: the main process.
 *
 * Shows the same page as the web app (built into dist-desktop by
 * `vite build --mode desktop`, served from app://neatnotes/), and gives it
 * access to exactly two folders through preload.cjs:
 *   notes   the notes folder the user chose (default Documents\NeatNotes)
 *   device  this computer's own state, in %AppData%\NeatNotes\device
 * The page has no other access to the computer.
 *
 * Environment (for tests and development):
 *   NEATNOTES_USER_DATA  use this folder instead of %AppData%\NeatNotes
 *   NEATNOTES_FOLDER     use this notes folder
 *   --dev                load the Vite dev server (http://localhost:5199) instead of dist-desktop
 */
const { app, BrowserWindow, ipcMain, protocol, net, shell, safeStorage, Menu, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const fsp = fs.promises
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')

app.setName('NeatNotes')
if (process.env.NEATNOTES_USER_DATA) app.setPath('userData', process.env.NEATNOTES_USER_DATA)
// tests only (never in the installed app): scripted answers for the Windows dialogs
if (!app.isPackaged && process.env.NEATNOTES_TEST_SETUP) require(process.env.NEATNOTES_TEST_SETUP)

const DEV = process.argv.includes('--dev')
const DEV_URL = 'http://localhost:5199/'
const APP_ORIGIN = 'app://neatnotes'
const DIST = path.join(__dirname, '..', 'dist-desktop')

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

// ---------- settings (this computer) ----------

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
  } catch {
    return {}
  }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch }
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  const tmp = `${settingsPath()}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, settingsPath())
}

const defaultFolder = () => process.env.NEATNOTES_FOLDER || path.join(app.getPath('documents'), 'NeatNotes')
const notesFolder = () => readSettings().folder || defaultFolder()

/** The two folders the page may use; fixed for the life of the window. */
let roots = null
function setupRoots() {
  roots = { notes: path.resolve(notesFolder()), device: path.join(app.getPath('userData'), 'device') }
  for (const r of Object.values(roots)) fs.mkdirSync(r, { recursive: true })
}

/** A path inside one of the folders; anything else is refused. */
function inRoot(root, rel) {
  const base = roots && roots[root]
  if (!base || typeof rel !== 'string' || rel.includes('\0') || path.isAbsolute(rel)) throw new Error('Not allowed')
  const full = path.resolve(base, rel)
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('Not allowed')
  return full
}

const isTemp = (name) => name.includes('.tmp-')

// ---------- files ----------

ipcMain.handle('fs:list', async (_e, root, dir) => {
  try {
    const entries = await fsp.readdir(inRoot(root, dir), { withFileTypes: true })
    return entries.filter((d) => d.isFile() && !isTemp(d.name)).map((d) => d.name)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
})

ipcMain.handle('fs:read', async (_e, root, rel) => {
  try {
    return new Uint8Array(await fsp.readFile(inRoot(root, rel)))
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
})

// Written to a temporary file first and renamed into place: never half written.
ipcMain.handle('fs:write', async (_e, root, rel, data) => {
  const full = inRoot(root, rel)
  await fsp.mkdir(path.dirname(full), { recursive: true })
  const tmp = `${full}.tmp-${crypto.randomBytes(4).toString('hex')}`
  const fh = await fsp.open(tmp, 'w')
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fsp.rename(tmp, full)
})

ipcMain.handle('fs:remove', async (_e, root, rel) => {
  await fsp.rm(inRoot(root, rel), { force: true })
})

ipcMain.handle('fs:removeDir', async (_e, root, rel) => {
  const full = inRoot(root, rel)
  if (full === roots[root]) throw new Error('Not allowed')
  await fsp.rm(full, { recursive: true, force: true })
})

// ---------- secrets (the GitHub token), encrypted for this Windows user ----------

const secretsPath = () => path.join(app.getPath('userData'), 'secrets.json')
function readSecrets() {
  try {
    return JSON.parse(fs.readFileSync(secretsPath(), 'utf8'))
  } catch {
    return {}
  }
}
ipcMain.on('secret:get', (e, key) => {
  const v = readSecrets()[key]
  try {
    e.returnValue = v ? safeStorage.decryptString(Buffer.from(v, 'base64')) : null
  } catch {
    e.returnValue = null // made for another Windows user, or damaged
  }
})
ipcMain.on('secret:set', (e, key, value) => {
  const all = readSecrets()
  if (value == null) delete all[key]
  else {
    if (!safeStorage.isEncryptionAvailable()) {
      e.returnValue = false
      return
    }
    all[key] = safeStorage.encryptString(String(value)).toString('base64')
  }
  fs.mkdirSync(path.dirname(secretsPath()), { recursive: true })
  fs.writeFileSync(secretsPath(), JSON.stringify(all))
  e.returnValue = true
})

// ---------- other ----------

ipcMain.on('app:info', (e) => {
  e.returnValue = { version: app.getVersion(), notesFolder: roots ? roots.notes : notesFolder() }
})
const isWebAddress = (url) => /^(https?:|mailto:)/i.test(String(url))
ipcMain.on('shell:open', (_e, url) => {
  if (isWebAddress(url)) void shell.openExternal(url)
})
ipcMain.on('folder:reveal', () => {
  if (roots) void shell.openPath(roots.notes)
})

// ---------- the notes folder, watched for files that arrive from elsewhere ----------

let watcher = null
function watchNotes(win) {
  watcher?.close()
  const changed = new Set()
  let timer = null
  try {
    watcher = fs.watch(roots.notes, { recursive: true }, (_event, name) => {
      if (!name || isTemp(name)) return
      changed.add(name.split(path.sep).join('/'))
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.send('notes:changed', [...changed])
        changed.clear()
      }, 300)
    })
    watcher.on('error', (e) => console.warn('NeatNotes: folder watch stopped', e))
  } catch (e) {
    console.warn('NeatNotes: cannot watch the notes folder', e)
  }
}

// ---------- choosing the notes folder ----------

/** NeatNotes' own content of a notes folder: everything in v2\, and pictures (files named by their id) in images\ */
const OWN_DIRS = ['v2', 'images']
const isPictureFile = (name) => /^[A-Za-z0-9_-]{20,64}$/.test(name)

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
/** one folder is the other, or inside it */
function overlaps(a, b) {
  const x = path.resolve(a).toLowerCase() + path.sep
  const y = path.resolve(b).toLowerCase() + path.sep
  return x.startsWith(y) || y.startsWith(x)
}

function hasNotes(dir) {
  try {
    return fs.readdirSync(path.join(dir, 'v2', 'workspace')).some((n) => n.endsWith('.bin'))
  } catch {
    return false
  }
}

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.neatnotes-check-${crypto.randomBytes(4).toString('hex')}`)
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe)
    return true
  } catch {
    return false
  }
}

async function pickFolder(win, defaultPath) {
  const options = {
    title: 'Choose a folder for your notes',
    defaultPath,
    buttonLabel: 'Use this folder',
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  }
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return r.canceled || !r.filePaths[0] ? null : path.resolve(r.filePaths[0])
}

function message(win, options) {
  const o = { noLink: true, ...options }
  return win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o)
}

/** A folder NeatNotes may use, or null (the user was told why not). */
async function checkFolder(win, dir, current) {
  if (overlaps(dir, app.getPath('userData')) || (current && !samePath(dir, current) && overlaps(dir, current))) {
    await message(win, { type: 'warning', message: 'Please choose another folder.', detail: 'The notes folder cannot be inside the current one, or contain it.' })
    return null
  }
  if (!canWrite(dir)) {
    await message(win, { type: 'error', message: 'NeatNotes cannot save in that folder.', detail: dir })
    return null
  }
  return dir
}

/** First start: where the notes go. */
async function firstRunFolder() {
  const suggested = defaultFolder()
  for (;;) {
    const { response } = await message(null, {
      type: 'question',
      title: 'Welcome to NeatNotes',
      message: 'Where should NeatNotes keep your notes?',
      detail:
        `Suggested: ${suggested}\n\n` +
        'Your notes are saved there as ordinary files, so you can back them up, or keep them in a synced folder such as OneDrive. ' +
        'To use notes you already have, choose their folder. You can change this later in the settings.',
      buttons: ['Use this folder', 'Choose another folder…'],
      defaultId: 0,
      cancelId: 0,
    })
    if (response === 0 && (await checkFolder(null, suggested))) return suggested
    if (response === 0) continue
    const picked = await pickFolder(null, path.dirname(suggested))
    if (picked && (await checkFolder(null, picked))) return picked
  }
}

/** Every file below `dir`, as paths relative to it. */
async function filesBelow(dir, rel = '') {
  let out = []
  let entries
  try {
    entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return out
    throw e
  }
  for (const d of entries) {
    const r = path.join(rel, d.name)
    if (d.isDirectory()) out = out.concat(await filesBelow(dir, r))
    else if (d.isFile() && !isTemp(d.name)) out.push(r)
  }
  return out
}
const ownFiles = async (root) =>
  (await Promise.all(OWN_DIRS.map(async (d) => (await filesBelow(root, d)).filter((r) => d !== 'images' || isPictureFile(path.basename(r)))))).flat()

/** Copies the notes into another folder and checks every copy. Files already there are kept (same name = same content). */
async function copyNotes(from, to) {
  const files = await ownFiles(from)
  for (const rel of files) {
    const dst = path.join(to, rel)
    await fsp.mkdir(path.dirname(dst), { recursive: true })
    await fsp.copyFile(path.join(from, rel), dst, fs.constants.COPYFILE_EXCL).catch((e) => {
      if (e.code !== 'EEXIST') throw e
    })
  }
  for (const rel of files) {
    const [a, b] = await Promise.all([fsp.stat(path.join(from, rel)), fsp.stat(path.join(to, rel))])
    if (a.size !== b.size) throw new Error(`${rel} was not copied completely`)
  }
  return files
}

/** Removes NeatNotes' files from a folder it no longer uses (nothing else), then the folders left empty. */
async function removeNotes(root, files) {
  for (const rel of files) await fsp.rm(path.join(root, rel), { force: true })
  const removeEmpty = async (dir) => {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of entries) if (d.isDirectory()) await removeEmpty(path.join(dir, d.name))
    await fsp.rmdir(dir).catch(() => {}) // only if empty
  }
  for (const d of OWN_DIRS) await removeEmpty(path.join(root, d))
  await fsp.rmdir(root).catch(() => {})
}

/** Asks the page to write everything not written yet (at most 5 s). */
function flushPage(win) {
  return new Promise((resolve) => {
    const done = () => {
      ipcMain.removeListener('app:flushed', done)
      clearTimeout(timer)
      resolve()
    }
    ipcMain.on('app:flushed', done)
    const timer = setTimeout(done, 5000)
    win.webContents.send('app:flush')
  })
}

/** Settings → Change folder. Moves the notes, or combines them with / switches to notes already there. */
ipcMain.handle('folder:change', async (e, syncOn) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  const from = roots.notes
  const picked = await pickFolder(win, path.dirname(from))
  if (!picked || samePath(picked, from)) return 'cancelled'
  const to = await checkFolder(win, picked, from)
  if (!to) return 'cancelled'

  let mode
  if (!hasNotes(to)) {
    const { response } = await message(win, {
      type: 'question',
      title: 'Move notes',
      message: 'Move your notes to this folder?',
      detail: `${to}\n\nAll notes and pictures are moved there, and NeatNotes keeps them there from now on.`,
      buttons: ['Move notes', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response !== 0) return 'cancelled'
    mode = 'move'
  } else {
    const { response } = await message(win, {
      type: 'question',
      title: 'Notes folder',
      message: 'This folder already has NeatNotes notes.',
      detail:
        `${to}\n\n` +
        'Combine: your notes are copied there too, and both appear together.\n' +
        `Use only those: your current notes stay in ${from} and are not shown.` +
        (syncOn ? '\n\nGitHub sync is on, so the notes on GitHub are added to that folder either way.' : ''),
      buttons: ['Combine', 'Use only those', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    })
    if (response === 2) return 'cancelled'
    mode = response === 0 ? 'combine' : 'switch'
  }

  await flushPage(win)
  let copied = []
  try {
    if (mode !== 'switch') copied = await copyNotes(from, to)
  } catch (err) {
    await message(win, { type: 'error', message: 'The notes could not be copied. Nothing was changed.', detail: String(err && err.message ? err.message : err) })
    return 'failed'
  }
  if (mode === 'switch') {
    // what this computer knows about GitHub described the old folder: start over
    await fsp.rm(path.join(roots.device, 'sync'), { recursive: true, force: true })
    await fsp.rm(path.join(roots.device, 'shadows'), { recursive: true, force: true })
  }
  // (after the reload, the first sync compares every page with GitHub and uploads what is new)
  writeSettings({ folder: to })
  if (mode === 'move') await removeNotes(from, copied).catch((err) => console.warn('NeatNotes: old folder not fully emptied', err))
  setupRoots()
  watchNotes(win)
  win.webContents.reload()
  return mode
})

// ---------- the window ----------

function createWindow() {
  setupRoots()
  const saved = readSettings().bounds
  const win = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 820,
    x: saved?.x,
    y: saved?.y,
    minWidth: 480,
    minHeight: 400,
    title: 'NeatNotes',
    icon: path.join(DIST, 'icons', 'icon-512.png'),
    backgroundColor: '#f6f5f1',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  })
  if (saved?.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())

  // links open in the browser; the window itself never leaves the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebAddress(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN) && !(DEV && url.startsWith(DEV_URL))) {
      e.preventDefault()
      if (isWebAddress(url)) void shell.openExternal(url)
    }
  })
  // developer tools only when not installed
  win.webContents.on('before-input-event', (_e, input) => {
    if (!app.isPackaged && input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win.webContents.toggleDevTools()
    }
  })

  // Before closing: let the page write what it has not written yet (at most 5 s).
  let canClose = false
  let closing = false
  win.on('close', (e) => {
    const b = win.getNormalBounds()
    writeSettings({ bounds: { ...b, maximized: win.isMaximized() } })
    if (canClose) return
    e.preventDefault()
    if (closing) return
    closing = true
    const done = () => {
      ipcMain.removeListener('app:flushed', done)
      clearTimeout(timer)
      canClose = true
      if (!win.isDestroyed()) win.close()
    }
    ipcMain.on('app:flushed', done)
    const timer = setTimeout(done, 5000)
    win.webContents.send('app:flush')
  })
  win.on('closed', () => watcher?.close())

  watchNotes(win)
  void win.loadURL(DEV ? DEV_URL : `${APP_ORIGIN}/index.html`)
  return win
}

// one window: opening NeatNotes again brings the open one forward
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    if (!readSettings().folder && !process.env.NEATNOTES_FOLDER) writeSettings({ folder: await firstRunFolder() })
    protocol.handle('app', async (req) => {
      const { pathname } = new URL(req.url)
      const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
      const full = path.resolve(DIST, '.' + rel)
      if (!full.startsWith(DIST + path.sep)) return new Response('Not found', { status: 404 })
      try {
        return await net.fetch(pathToFileURL(full).toString())
      } catch {
        return new Response('Not found', { status: 404 })
      }
    })
    createWindow()
  })
  app.on('window-all-closed', () => app.quit())
}
