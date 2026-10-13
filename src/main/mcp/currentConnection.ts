import { EventEmitter } from 'events'
import type { Client } from 'basic-ftp'
import type { ConnKey } from '@shared/connKey'
import type {
  ConnectionStatus,
  FtpConnectPayload,
  FtpConnectionState,
  FtpListResult
} from '@shared/types/ftp'
import type { TransferDirection, TransferEnqueueItem, TransferJob } from '@shared/types/transfer'
import type { ConnectionRegistry, ConnectResult, FtpSession } from '../ftp/ConnectionRegistry'
import type { DeleteProgressCallback } from '../ftp/FtpFileOperations'
import type { EnqueueOptions } from '../transfer/TransferQueue'
import type { TransferHub } from '../transfer/TransferHub'

/**
 * 에이전트 도구가 보는 "지금 연결" (multi-connection S1의 임시 어댑터). 앱은 아직 한 번에 한 서버에만
 * 연결하므로(레지스트리 single) 도구는 연결된 세션을, 없으면 마지막으로 상태가 바뀐 세션을 매니저·파일
 * 작업·큐 자리에서 쓴다. 전송 목록은 허브 전체다. 세션의 `connectionStatus`를 그대로 다시 내 MCP 미리보기가
 * 연결이 바뀐 것을 안다. S5에서 대상 연결 고르기(agentTarget)가 이것을 대신한다.
 */
export class CurrentConnection extends EventEmitter {
  private last: ConnKey = ''

  constructor(
    private registry: ConnectionRegistry,
    private hub: TransferHub
  ) {
    super()
    registry.on('connectionStatus', (state: FtpConnectionState) => {
      this.last = state.server
      this.emit('connectionStatus', state)
    })
  }

  private session(): FtpSession | undefined {
    const [live] = this.registry.connectedKeys()
    return this.registry.get(live ?? this.last)
  }

  /** 연결된 세션. 없으면 매니저처럼 'Not connected'로 실패한다. */
  private live(): FtpSession {
    const session = this.session()
    if (!session?.manager.isConnected()) throw new Error('Not connected')
    return session
  }

  connect(payload: FtpConnectPayload): Promise<ConnectResult> {
    return this.registry.connect(payload)
  }

  async disconnect(): Promise<void> {
    const session = this.session()
    if (session) await this.registry.disconnect(session.key)
  }

  async list(remotePath: string): Promise<FtpListResult> {
    return this.live().manager.list(remotePath)
  }

  isConnected(): boolean {
    return this.session()?.manager.isConnected() ?? false
  }

  getStatus(): ConnectionStatus {
    return this.session()?.manager.getStatus() ?? 'disconnected'
  }

  getHost(): string {
    return this.session()?.manager.getHost() ?? ''
  }

  getPort(): number {
    return this.session()?.manager.getPort() ?? 0
  }

  getUser(): string {
    return this.session()?.manager.getUser() ?? ''
  }

  getConnKey(): ConnKey {
    return this.session()?.key ?? ''
  }

  async createSecondaryClient(): Promise<Client> {
    return this.live().manager.createSecondaryClient()
  }

  async runOnMainClient<T>(task: (client: Client) => Promise<T>): Promise<T> {
    return this.live().manager.runOnMainClient(task)
  }

  async mkdir(remotePath: string): Promise<void> {
    return this.live().fileOps.mkdir(remotePath)
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    return this.live().fileOps.rename(oldPath, newPath)
  }

  async deleteFile(remotePath: string): Promise<void> {
    return this.live().fileOps.deleteFile(remotePath)
  }

  async deleteDirectory(remotePath: string, onProgress?: DeleteProgressCallback): Promise<void> {
    return this.live().fileOps.deleteDirectory(remotePath, onProgress)
  }

  enqueueBatch(
    direction: TransferDirection,
    items: TransferEnqueueItem[],
    forceBatch?: boolean,
    remoteDirs?: string[],
    options?: EnqueueOptions
  ): string[] {
    return this.live().queue.enqueueBatch(direction, items, forceBatch, remoteDirs, options)
  }

  getAll(): TransferJob[] {
    return this.hub.getAll()
  }
}
