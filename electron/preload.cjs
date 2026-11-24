/**
 * NeatNotes for Windows: what the page may ask of the main process.
 * Exposed as window.neatnotes; described in src/desktop/api.ts.
 */
const { contextBridge, ipcRenderer } = require('electron')

const info = ipcRenderer.sendSync('app:info')

contextBridge.exposeInMainWorld('neatnotes', {
  version: info.version,
  notesFolder: info.notesFolder,
  list: (root, dir) => ipcRenderer.invoke('fs:list', root, dir),
  read: (root, path) => ipcRenderer.invoke('fs:read', root, path),
  write: (root, path, data) => ipcRenderer.invoke('fs:write', root, path, data),
  remove: (root, path) => ipcRenderer.invoke('fs:remove', root, path),
  removeDir: (root, dir) => ipcRenderer.invoke('fs:removeDir', root, dir),
  onNotesChanged: (fn) => {
    const listener = (_e, paths) => fn(paths)
    ipcRenderer.on('notes:changed', listener)
    return () => ipcRenderer.removeListener('notes:changed', listener)
  },
  onFlushRequest: (fn) => {
    ipcRenderer.on('app:flush', async () => {
      try {
        await fn()
      } finally {
        ipcRenderer.send('app:flushed')
      }
    })
  },
  secretGet: (key) => ipcRenderer.sendSync('secret:get', key),
  secretSet: (key, value) => {
    if (!ipcRenderer.sendSync('secret:set', key, value)) throw new Error('Windows could not encrypt the token')
  },
  openExternal: (url) => ipcRenderer.send('shell:open', url),
  revealNotesFolder: () => ipcRenderer.send('folder:reveal'),
})
