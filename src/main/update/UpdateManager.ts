import type { UpdateState, UpdateStatus } from '@shared/types/update'

interface UpdateInfo {
  version: string
}

interface DownloadProgress {
  percent: number
}

export interface UpdateClient {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'update-available', listener: (info: UpdateInfo) => void): unknown
  on(event: 'update-not-available', listener: (info: UpdateInfo) => void): unknown
  on(event: 'download-progress', listener: (progress: DownloadProgress) => void): unknown
  on(event: 'update-downloaded', listener: (info: UpdateInfo) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

/**
 * 이 상태에서는 재확인하지 않는다. checking·downloading은 이미 진행 중이고, ready는 다 받아 둔
 * 업데이트를 available로 되돌려 사용자가 같은 파일을 다시 받게 만들기 때문이다.
 */
const CHECK_BLOCKING_STATUSES: readonly UpdateStatus[] = ['checking', 'downloading', 'ready']

interface UpdateSupportOptions {
  isPackaged: boolean
  platform: string
  isPortable: boolean
  isSmokeTest: boolean
}

export function isAutomaticUpdateSupported(options: UpdateSupportOptions): boolean {
  return (
    options.isPackaged &&
    options.platform === 'win32' &&
    !options.isPortable &&
    !options.isSmokeTest
  )
}

export class UpdateManager {
  private state: UpdateState

  constructor(
    currentVersion: string,
    private readonly updater: UpdateClient | null,
    private readonly emitState: (state: UpdateState) => void,
    private autoUpdate = false
  ) {
    this.state = updater
      ? { status: 'idle', currentVersion, autoUpdate }
      : {
          status: 'unsupported',
          currentVersion,
          autoUpdate,
          message: 'Automatic updates are available in the installed Windows version.'
        }

    if (!updater) return

    this.applyAutoUpdate()
    updater.on('update-available', (info) => {
      this.setState({
        status: 'available',
        currentVersion,
        autoUpdate: this.autoUpdate,
        availableVersion: info.version
      })
    })
    updater.on('update-not-available', () => {
      this.setState({ status: 'up-to-date', currentVersion, autoUpdate: this.autoUpdate })
    })
    updater.on('download-progress', (progress) => {
      this.setState({
        ...this.state,
        status: 'downloading',
        progressPercent: progress.percent
      })
    })
    updater.on('update-downloaded', (info) => {
      this.setState({
        status: 'ready',
        currentVersion,
        autoUpdate: this.autoUpdate,
        availableVersion: info.version,
        progressPercent: 100
      })
    })
    updater.on('error', (error) => {
      this.setError(error)
    })
  }

  getState(): UpdateState {
    return { ...this.state }
  }

  async check(): Promise<UpdateState> {
    if (!this.updater || CHECK_BLOCKING_STATUSES.includes(this.state.status)) {
      return this.getState()
    }

    this.setState({
      status: 'checking',
      currentVersion: this.state.currentVersion,
      autoUpdate: this.autoUpdate
    })
    try {
      const result = (await this.updater.checkForUpdates()) as {
        downloadPromise?: Promise<unknown>
      } | null
      // 자동 다운로드 실패는 'error' 이벤트로 이미 알리므로, 같은 실패의 promise는 삼킨다.
      result?.downloadPromise?.catch(() => undefined)
    } catch (error) {
      this.setError(error)
    }
    return this.getState()
  }

  async download(): Promise<UpdateState> {
    if (!this.updater || this.state.status !== 'available') return this.getState()

    this.setState({ ...this.state, status: 'downloading', progressPercent: 0 })
    try {
      await this.updater.downloadUpdate()
    } catch (error) {
      this.setError(error)
    }
    return this.getState()
  }

  /**
   * On: electron-updater downloads a found update by itself and installs it on quit, so the
   * next launch is already the new version. Turning it on while an update is only
   * `available` starts that download now.
   */
  async setAutoUpdate(enabled: boolean): Promise<UpdateState> {
    this.autoUpdate = enabled
    this.applyAutoUpdate()
    this.setState({ ...this.state, autoUpdate: enabled })
    if (enabled) return this.download()
    return this.getState()
  }

  install(): void {
    if (!this.updater || this.state.status !== 'ready') return
    this.updater.quitAndInstall(false, true)
  }

  /**
   * electron-updater registers its install-on-quit handler only if `autoInstallOnAppQuit` is
   * true when a download finishes, then re-reads the flag at quit. So the flag stays true here
   * (the handler always exists) and {@link beforeQuit} sets the real choice just before quitting —
   * otherwise an update downloaded before auto-update was turned on would never install.
   */
  private applyAutoUpdate(): void {
    if (!this.updater) return
    this.updater.autoDownload = this.autoUpdate
    this.updater.autoInstallOnAppQuit = true
  }

  /** Call from `app.on('before-quit')`. */
  beforeQuit(): void {
    if (this.updater) this.updater.autoInstallOnAppQuit = this.autoUpdate
  }

  private setError(error: unknown): void {
    this.setState({
      status: 'error',
      currentVersion: this.state.currentVersion,
      autoUpdate: this.autoUpdate,
      message: error instanceof Error ? error.message : String(error)
    })
  }

  private setState(state: UpdateState): void {
    this.state = state
    this.emitState(this.getState())
  }
}
