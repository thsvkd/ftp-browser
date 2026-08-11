import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'
import { initDatabase } from './db/database'
import { registerFtpHandlers } from './ipc/ftpHandlers'
import { registerLocalFsHandlers } from './ipc/localFsHandlers'
import { registerOperationHandlers } from './ipc/operationHandlers'
import { registerTransferHandlers } from './ipc/transferHandlers'
import { registerThumbnailHandlers } from './ipc/thumbnailHandlers'
import { registerPreviewHandlers } from './ipc/previewHandlers'
import { registerDragHandlers } from './ipc/dragHandlers'
import { registerGalleryHandlers } from './ipc/galleryHandlers'
import { registerDevtools } from './debug/devtools'
import { applyApplicationMenu } from './menu/appMenu'
import { isDebugEnabled, debugRendererArgs, DEVTOOLS_FLAG } from '@shared/debug'
import { APP_NAME } from '@shared/constants'

const isDev = !app.isPackaged
const debugEnabled = isDebugEnabled(process.argv)

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: false,
    title: APP_NAME,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      additionalArguments: debugRendererArgs(debugEnabled)
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId(isDev ? process.execPath : 'com.ftp-browser')
  }

  if (debugEnabled) {
    // Mirrors matchDebugShortcut: macOS adds the Cmd+Option pair and still
    // accepts the Windows chords, so both are worth announcing there (D8).
    const macOnlyChords = process.platform === 'darwin' ? 'Cmd+Option+I, Cmd+Option+C, ' : ''
    console.log(
      `[debug] Developer tools enabled (${DEVTOOLS_FLAG}): ` +
        `${macOnlyChords}F12, Ctrl+Shift+C, Shift+right-click`
    )
  }

  app.on('browser-window-created', (_, window) => {
    registerDevtools(window, debugEnabled, process.platform)
  })

  applyApplicationMenu(process.platform)
  const win = createWindow()
  const db = initDatabase()

  // Register IPC handlers
  const operationManager = registerOperationHandlers(win)
  const { manager, fileOps } = registerFtpHandlers(win, operationManager)
  registerLocalFsHandlers(win, operationManager)
  registerTransferHandlers(win, fileOps)
  registerThumbnailHandlers(win, db, manager)
  registerPreviewHandlers(db, manager)
  registerDragHandlers(manager)
  registerGalleryHandlers(win, db, manager)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
