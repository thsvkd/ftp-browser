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

  constructor() {
    super()
    this.client = createConfiguredClient()
  }

  async connect(config: FtpConnectPayload): Promise<{ success: boolean; error?: string }> {
    try {
      this.emitStatus('connecting', config.host)

      // Re-create client to ensure clean state
      this.client.close()
      this.client = createConfiguredClient()

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

  async list(remotePath: string): Promise<FtpListResult> {
    const fileInfos: FileInfo[] = await this.client.list(remotePath)

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
