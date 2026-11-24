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
const { app, BrowserWindow, ipcMain, protocol, net, shell, safeStorage, Menu } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const fsp = fs.promises
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')

app.setName('NeatNotes')
if (process.env.NEATNOTES_USER_DATA) app.setPath('userData', process.env.NEATNOTES_USER_DATA)

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

const notesFolder = () => process.env.NEATNOTES_FOLDER || readSettings().folder || path.join(app.getPath('documents'), 'NeatNotes')

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

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
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
