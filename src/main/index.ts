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
import { registerUpdateHandlers } from './ipc/updateHandlers'
import { registerMcpHandlers } from './ipc/mcpHandlers'
import { McpService } from './mcp/McpService'
import { createMcpToolServer } from './mcp/mcpTools'
import { createThumbnailPreviewer } from './mcp/thumbnailPreviews'
import { registerDevtools } from './debug/devtools'
import { applyApplicationMenu } from './menu/appMenu'
import { UpdateManager, isAutomaticUpdateSupported } from './update/UpdateManager'
import { autoUpdater } from 'electron-updater'
import {
  PACKAGED_SMOKE_USER_DATA_ENV,
  isPackagedSmokeTest,
  startPackagedSmokeTest
} from './smokeTest'
import { isDebugEnabled, debugRendererArgs, DEVTOOLS_FLAG } from '@shared/debug'
import { APP_NAME } from '@shared/constants'

const isDev = !app.isPackaged
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const debugEnabled = isDebugEnabled(process.argv)
const smokeTestEnabled = isPackagedSmokeTest(process.argv, app.isPackaged)
const smokeUserDataPath = process.env[PACKAGED_SMOKE_USER_DATA_ENV]

if (smokeTestEnabled && smokeUserDataPath) {
  app.setPath('userData', smokeUserDataPath)
}

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
    if (!smokeTestEnabled) mainWindow?.show()
  })

  if (smokeTestEnabled) {
    startPackagedSmokeTest(mainWindow.webContents, {
      exit: (code) => app.exit(code),
      log: (message) => console.log(message),
      error: (message) => console.error(message),
      setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
      clearTimeout: (handle) => clearTimeout(handle)
    })
  }

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
  if (smokeTestEnabled && !smokeUserDataPath) {
    console.error(`[smoke] ${PACKAGED_SMOKE_USER_DATA_ENV} is required`)
    app.exit(1)
    return
  }

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
  const transferQueue = registerTransferHandlers(win, fileOps, manager)
  const { cacheManager, generator } = registerThumbnailHandlers(win, db, manager)
  registerPreviewHandlers(db, manager)
  registerDragHandlers(manager)
  registerGalleryHandlers(win, db, manager)

  // 내장 MCP 서버는 GUI와 같은 연결·전송 큐·썸네일 캐시를 읽기 전용으로 쓴다(기본 꺼짐)
  const previews = createThumbnailPreviewer(manager, generator, cacheManager)
  const mcp = new McpService(db, () =>
    createMcpToolServer({
      version: app.getVersion(),
      ftp: manager,
      transfers: transferQueue,
      previews
    })
  )
  registerMcpHandlers(mcp)
  void mcp.init()
  app.on('will-quit', () => void mcp.stop())

  const automaticUpdateSupported = isAutomaticUpdateSupported({
    isPackaged: app.isPackaged,
    platform: process.platform,
    isPortable: process.env.PORTABLE_EXECUTABLE_FILE !== undefined,
    isSmokeTest: smokeTestEnabled
  })
  const autoUpdateRow = db.prepare("SELECT value FROM settings WHERE key = 'autoUpdate'").get() as
    | { value: string }
    | undefined
  const updateManager = new UpdateManager(
    app.getVersion(),
    automaticUpdateSupported ? autoUpdater : null,
    (state) => {
      if (!win.isDestroyed()) win.webContents.send('update:stateChanged', state)
    },
    autoUpdateRow?.value !== '0'
  )
  registerUpdateHandlers(updateManager, (enabled) => {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('autoUpdate', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(enabled ? '1' : '0')
  })
  if (automaticUpdateSupported) {
    win.webContents.once('did-finish-load', () => {
      void updateManager.check()
    })
    app.on('before-quit', () => updateManager.beforeQuit())
    // 오래 켜 두는 앱이라 시작 시 한 번만 확인하면 며칠씩 뒤처질 수 있다.
    setInterval(() => void updateManager.check(), UPDATE_CHECK_INTERVAL_MS)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
