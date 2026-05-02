import { Client, FileInfo } from 'basic-ftp'
import { EventEmitter } from 'events'
import { isImageFile } from '@shared/constants'
import { classifyError } from '../utils/errorClassifier'
import type {
  FtpConnectPayload,
  FtpFileEntry,
  FtpListResult,
  FtpConnectionState
} from '@shared/types/ftp'

/**
 * 원격 측 상태를 변경한 작업의 알림. 폴더 미리보기 등 캐시 무효화 hook이 구독한다.
 * `download`처럼 read-only 작업은 emit하지 않는다.
 */
export interface FtpMutationEvent {
  kind: 'delete' | 'rename' | 'mkdir' | 'upload'
  remotePath: string
  newPath?: string
}

const CLIENT_TIMEOUT_MS = 30_000

function createConfiguredClient(): Client {
  const client = new Client(CLIENT_TIMEOUT_MS, { allowSeparateTransferHost: false })
  client.ftp.verbose = process.env.NODE_ENV === 'development'
  client.ftp.ipFamily = 4
  return client
}

export class FtpConnectionManager extends EventEmitter {
  private client: Client
  private _connected = false
  private _host = ''
  private _port = 0
  private _config: FtpConnectPayload | null = null
  /**
   * basic-ftp Client는 한 번에 하나의 task만 실행 가능. 메인 클라이언트를 공유하는
   * 모든 경로(list, transfer, thumbnail/preview fallback 등)를 이 promise chain으로
   * 직렬화하여 "Client is closed because user launched task while another one is still
   * running" 에러를 방지한다.
   */
  private mainClientLock: Promise<unknown> = Promise.resolve()

  constructor() {
    super()
    this.client = createConfiguredClient()
  }

  async connect(config: FtpConnectPayload): Promise<{ success: boolean; error?: string }> {
    try {
      this.emitStatus('connecting', config.host)

      // Re-create client to ensure clean state. 큐에 남아있던 task들은 새 client에서
      // 동작하지만, close된 이전 client에서 진행 중이던 task는 자연스럽게 reject된다.
      this.client.close()
      this.client = createConfiguredClient()
      this.mainClientLock = Promise.resolve()

      await this.client.access({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        secure: config.secure
      })

      this._connected = true
      this._host = config.host
      this._port = config.port
      this._config = config
      this.monitorConnection()
      this.emitStatus('connected', config.host)

      return { success: true }
    } catch (err) {
      this._connected = false
      const { message } = classifyError(err)
      this.emitStatus('error', config.host, message)
      return { success: false, error: message }
    }
  }

  /**
   * 메인 클라이언트의 task를 직렬 실행. 절대로 task 안에서 Promise.race로 timeout을
   * 설정하지 말 것. (timeout이 win하더라도 underlying basic-ftp task는 계속 진행되어
   * 다음 task와 충돌한다.) basic-ftp Client 생성자에 설정된 timeout(30s)이 stuck
   * 상황을 처리한다.
   *
   * disconnect/connect 사이에 들어온 task는 stale client에 도달하지 않도록 두 시점에
   * 모두 connection 상태를 검증한다 (큐잉 시점 + then-time).
   * 또한 task 안에서 `this.client`를 then-time에 읽으므로, 재연결 시 새 client가
   * 큐잉되어 있던 task에게 swap된다.
   */
  async runOnMainClient<T>(task: (client: Client) => Promise<T>): Promise<T> {
    if (!this._connected) {
      return Promise.reject(new Error('Not connected'))
    }
    const next = this.mainClientLock.then(() => {
      if (!this._connected) throw new Error('Not connected')
      return task(this.client)
    })
    this.mainClientLock = next.catch(() => undefined)
    return next
  }

  async list(remotePath: string): Promise<FtpListResult> {
    const fileInfos: FileInfo[] = await this.runOnMainClient((client) => client.list(remotePath))

    const entries: FtpFileEntry[] = fileInfos.map((fi) => ({
      name: fi.name,
      type: fi.isDirectory ? 'directory' : fi.isSymbolicLink ? 'symbolic-link' : 'file',
      size: fi.size,
      modifiedAt: fi.modifiedAt?.toISOString() ?? '',
      rawModifiedAt: fi.rawModifiedAt ?? '',
      permissions: fi.permissions
        ? `${fi.permissions.user}${fi.permissions.group}${fi.permissions.world}`
        : undefined,
      isImage: !fi.isDirectory && isImageFile(fi.name)
    }))

    return { path: remotePath, entries }
  }

  async disconnect(): Promise<void> {
    this.client.close()
    this._connected = false
    this._config = null
    this.emitStatus('disconnected')
  }

  /** 썸네일 다운로드 등 별도 작업용 독립 FTP 클라이언트 생성 */
  async createSecondaryClient(): Promise<Client> {
    if (!this._config) throw new Error('Not connected')
    const client = createConfiguredClient()
    await client.access({
      host: this._config.host,
      port: this._config.port,
      user: this._config.user,
      password: this._config.password,
      secure: this._config.secure
    })
    return client
  }

  getClient(): Client {
    return this.client
  }

  isConnected(): boolean {
    return this._connected
  }

  getHost(): string {
    return this._host
  }

  getPort(): number {
    return this._port
  }

  /** 소켓 이벤트를 감지하여 예상치 못한 연결 끊김을 renderer에 알림 */
  private monitorConnection(): void {
    const socket = this.client.ftp.socket
    const onClose = (hadError: boolean): void => {
      if (this._connected) {
        this._connected = false
        this.emitStatus(
          'error',
          this._host,
          hadError ? 'Connection lost due to an error.' : 'Connection closed by server.'
        )
      }
    }
    const onError = (err: Error): void => {
      if (this._connected) {
        this._connected = false
        this.emitStatus('error', this._host, `Connection error: ${err.message}`)
      }
    }
    socket.once('close', onClose)
    socket.once('error', onError)
  }

  private emitStatus(status: FtpConnectionState['status'], host?: string, error?: string): void {
    const state: FtpConnectionState = { status, host, error }
    this.emit('connectionStatus', state)
  }
}
