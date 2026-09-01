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
    private readonly emitState: (state: UpdateState) => void
  ) {
    this.state = updater
      ? { status: 'idle', currentVersion }
      : {
          status: 'unsupported',
          currentVersion,
          message: 'Automatic updates are available in the installed Windows version.'
        }

    if (!updater) return

    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.on('update-available', (info) => {
      this.setState({
        status: 'available',
        currentVersion,
        availableVersion: info.version
      })
    })
    updater.on('update-not-available', () => {
      this.setState({ status: 'up-to-date', currentVersion })
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

    this.setState({ status: 'checking', currentVersion: this.state.currentVersion })
    try {
      await this.updater.checkForUpdates()
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

  install(): void {
    if (!this.updater || this.state.status !== 'ready') return
    this.updater.quitAndInstall(false, true)
  }

  private setError(error: unknown): void {
    this.setState({
      status: 'error',
      currentVersion: this.state.currentVersion,
      message: error instanceof Error ? error.message : String(error)
    })
  }

  private setState(state: UpdateState): void {
    this.state = state
    this.emitState(this.getState())
  }
}
