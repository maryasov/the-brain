import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { registerIpc, watchAppFocus } from './ipc.js'
import { closeDb } from './db.js'

// electron-vite emits the preload as .mjs (ESM) or .js depending on config;
// resolve whichever actually exists on disk.
function resolvePreload(): string {
  for (const file of ['index.mjs', 'index.js']) {
    const p = join(__dirname, '../preload', file)
    if (existsSync(p)) return p
  }
  return join(__dirname, '../preload/index.mjs')
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#0f1218',
    autoHideMenuBar: true,
    title: 'The Brain',
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // Open external links in the OS browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  watchAppFocus(win)
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => closeDb())
