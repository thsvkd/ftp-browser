import { app, shell, BrowserWindow, safeStorage } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'
import { initDatabase } from './db/database'
import { createPasswordVault } from './db/passwordVault'
import { registerFtpHandlers } from './ipc/ftpHandlers'
import { registerLocalFsHandlers } from './ipc/localFsHandlers'
import { registerOperationHandlers } from './ipc/operationHandlers'
import { registerTransferHandlers } from './ipc/transferHandlers'
import { registerThumbnailHandlers, thumbnailEvents } from './ipc/thumbnailHandlers'
import { registerPreviewHandlers } from './ipc/previewHandlers'
import { registerDragHandlers } from './ipc/dragHandlers'
import { registerGalleryHandlers } from './ipc/galleryHandlers'
import { registerUpdateHandlers } from './ipc/updateHandlers'
import { registerAppHandlers } from './ipc/appHandlers'
import { buildCliCommand, bundledCliPath, registerMcpHandlers } from './ipc/mcpHandlers'
import { McpService } from './mcp/McpService'
import { createMcpToolServer, type McpToolDeps } from './mcp/mcpTools'
import { createJobTracker } from './mcp/jobTracker'
import { createThumbnailPreviewer } from './mcp/thumbnailPreviews'
import { CurrentConnection } from './mcp/currentConnection'
import { ConnectionRegistry, createSession } from './ftp/ConnectionRegistry'
import { RemoteFolderPreviewCache } from './ftp/RemoteFolderPreviewCache'
import { TransferHub } from './transfer/TransferHub'
import { CacheManager } from './thumbnail/CacheManager'
import { ThumbnailGenerator } from './thumbnail/ThumbnailGenerator'
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
    minWidth: 1024,
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
  // 저장된 비밀번호는 safeStorage 비동기 API로 암호화한다(앱 ready 뒤에만 쓸 수 있다).
  // 예전 평문 행은 백그라운드에서 옮기고, 실패한 행은 평문 그대로 남는다(E4·E5).
  const passwords = createPasswordVault(db, safeStorage)
  void passwords.migrate().then(
    ({ migrated, failed }) => {
      if (migrated > 0 || failed > 0) {
        console.log(`[passwords] Encrypted ${migrated} saved password(s), ${failed} failed`)
      }
    },
    (err) => console.error('[passwords] Saved-password migration failed:', err)
  )

  // 연결마다 세션(매니저·파일 작업·전송 큐·풀·썸네일·폴더 미리보기 큐)이 하나다. 세션 팩토리가 쓰는
  // 캐시·생성기는 앱에 하나라 레지스트리보다 먼저 만든다(multi-connection §8-4).
  // 연결은 아직 하나다(single, S3에서 다중 연결을 켠다).
  const cacheManager = new CacheManager(db)
  const generator = new ThumbnailGenerator()
  const folderCache = new RemoteFolderPreviewCache(db)
  const shared = { cacheManager, generator, folderCache, ...thumbnailEvents(win) }
  const registry = new ConnectionRegistry((key) => createSession(key, shared), { single: true })
  const hub = new TransferHub(registry)

  // Register IPC handlers
  const operationManager = registerOperationHandlers(win)
  registerFtpHandlers(win, operationManager, passwords, registry)
  const localFs = registerLocalFsHandlers(win, operationManager)
  registerTransferHandlers(win, registry, hub, localFs)
  registerThumbnailHandlers(registry, cacheManager)
  registerPreviewHandlers(db, registry)
  registerDragHandlers(registry)
  registerGalleryHandlers(win, registry, folderCache)
  registerAppHandlers()

  // 에이전트(내장 MCP 서버, ftpb)는 GUI와 같은 연결·전송 큐·파일 작업·썸네일 캐시를 쓴다(기본 꺼짐).
  // 도구는 아직 연결 하나만 본다(CurrentConnection, S5에서 대상 연결 고르기로 바뀐다).
  const current = new CurrentConnection(registry, hub)
  const agentDeps: McpToolDeps = {
    version: app.getVersion(),
    db,
    ftp: current,
    fileOps: current,
    queue: current,
    operations: operationManager,
    localFs,
    passwords,
    previews: createThumbnailPreviewer(current, generator, cacheManager),
    jobs: createJobTracker(hub, operationManager),
    onSession: (event) => {
      if (!win.isDestroyed()) win.webContents.send('agent:session', event)
    }
  }
  const mcp = new McpService(db, () => createMcpToolServer(agentDeps), undefined, {
    userDataDir: app.getPath('userData'),
    version: app.getVersion()
  })
  registerMcpHandlers(
    mcp,
    buildCliCommand(process.platform, process.execPath, bundledCliPath(__dirname))
  )
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
