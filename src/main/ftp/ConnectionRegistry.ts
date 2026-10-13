import { EventEmitter } from 'events'
import { connKey, parseConnKey, type ConnKey } from '@shared/connKey'
import { ErrorCode, type ErrorCodeType } from '@shared/types/ipc'
import type {
  ConnectionStatus,
  FtpConnectPayload,
  FtpConnectionState,
  FtpMutationEvent,
  RemoteChangedEvent
} from '@shared/types/ftp'
import { FtpConnectionManager, type ManagerStatus } from './FtpConnectionManager'
import { FtpFileOperations } from './FtpFileOperations'
import { RemoteGalleryPreviewQueue } from './RemoteGalleryPreviewQueue'
import type { RemoteFolderPreviewCache } from './RemoteFolderPreviewCache'
import { TransferClientPool } from '../transfer/TransferClientPool'
import { TransferQueue } from '../transfer/TransferQueue'
import { ThumbnailQueue, type ThumbnailResult } from '../thumbnail/ThumbnailQueue'
import type { ThumbnailGenerator } from '../thumbnail/ThumbnailGenerator'
import type { CacheManager } from '../thumbnail/CacheManager'
import { ipcError } from '../utils/errorClassifier'

/** 연결 하나와 그 연결만 보는 서비스들(multi-connection MC1). 세션은 앱이 끝날 때까지 남는다(MC5). */
export interface FtpSession {
  key: ConnKey
  manager: FtpConnectionManager
  fileOps: FtpFileOperations
  pool: TransferClientPool
  queue: TransferQueue
  thumbs: ThumbnailQueue
  gallery: RemoteGalleryPreviewQueue
}

/** 앱에 하나인, 세션들이 함께 쓰는 것 */
export interface SessionShared {
  generator: ThumbnailGenerator
  cacheManager: CacheManager
  folderCache: RemoteFolderPreviewCache
  onThumbnailReady(result: ThumbnailResult): void
  onThumbnailError(cacheKey: string, error: string): void
}

/** 세션 팩토리. 큐·풀·썸네일 큐는 지금처럼 자기 매니저만 본다. */
export function createSession(key: ConnKey, shared: SessionShared): FtpSession {
  const manager = new FtpConnectionManager()
  const fileOps = new FtpFileOperations(manager)
  const pool = new TransferClientPool(manager)
  const queue = new TransferQueue(fileOps, pool, { server: key })
  // 큐가 만든 폴더도 탐색 캐시가 알아야 한다(ftp:mkdir이 내던 mutation과 같다)
  queue.on('dir:created', (remotePath: string) => {
    manager.emit('mutation', { kind: 'mkdir', remotePath } satisfies FtpMutationEvent)
  })
  const thumbs = new ThumbnailQueue(
    manager,
    shared.generator,
    shared.cacheManager,
    shared.onThumbnailReady,
    shared.onThumbnailError
  )
  const gallery = new RemoteGalleryPreviewQueue(manager, shared.folderCache)
  return { key, manager, fileOps, pool, queue, thumbs, gallery }
}

/** 원격 IPC의 연결 인자가 틀렸다(키 형식) 또는 그 연결이 없다(`FTP_NOT_CONNECTED`). */
export class SessionError extends Error {
  constructor(
    message: string,
    readonly code?: ErrorCodeType
  ) {
    super(message)
  }
}

/** 원격 IPC 핸들러의 실패 값. 연결 인자 오류는 그 문구 그대로, 나머지는 ipcError로 분류한다. */
export function sessionIpcError(err: unknown): {
  success: false
  error: string
  code?: ErrorCodeType
} {
  if (!(err instanceof SessionError)) return ipcError(err)
  return err.code
    ? { success: false, error: err.message, code: err.code }
    : { success: false, error: err.message }
}

export interface ConnectResult {
  server: ConnKey
  success: boolean
  error?: string
  cancelled?: boolean
}

export interface RegistryOptions {
  /**
   * 연결은 아직 하나다(S1~S2): connect가 다른 세션을 먼저 끊는다. 렌더러가 연결 하나만 아는 동안
   * 에이전트의 connect도 지금처럼 이전 연결을 바꾼다. S3에서 지운다(MC5).
   */
  single?: boolean
}

/**
 * 연결 키(`user@host:port`)마다 세션 하나. 세션은 그 키로 처음 connect할 때 만들고 지우지 않는다(끊긴
 * 세션의 큐에 남은 작업을 다시 연결한 뒤 재시도할 수 있다). 매니저의 이벤트는 키를 모르므로 여기서
 * `server`를 붙여 다시 낸다: `connectionStatus`(FtpConnectionState), `mutation`(RemoteChangedEvent),
 * `session`(새 세션).
 */
export class ConnectionRegistry extends EventEmitter {
  private byKey = new Map<ConnKey, FtpSession>()
  /** 마지막 `error` 상태의 문구. 다른 상태가 오면 지운다. */
  private errors = new Map<ConnKey, string>()
  /** 진행 중인 로그인. 같은 키로 동시에 온 connect는 이것을 함께 기다린다. */
  private logins = new Map<ConnKey, Promise<ConnectResult>>()

  constructor(
    private newSession: (key: ConnKey) => FtpSession,
    private options: RegistryOptions = {}
  ) {
    super()
  }

  /**
   * 그 키의 세션으로 연결한다. 이미 연결돼 있으면 다시 로그인하지 않는다: 로그인은 매니저가 `connecting`을
   * 알려 그 연결의 풀·썸네일 큐를 비운다(§8-7).
   */
  connect(payload: FtpConnectPayload): Promise<ConnectResult> {
    const key = connKey(payload.host, payload.port, payload.user)
    const pending = this.logins.get(key)
    if (pending) return pending
    const session = this.ensure(key)
    if (session.manager.isConnected()) return Promise.resolve({ server: key, success: true })
    const login = this.login(session, payload).finally(() => this.logins.delete(key))
    this.logins.set(key, login)
    return login
  }

  private async login(session: FtpSession, payload: FtpConnectPayload): Promise<ConnectResult> {
    if (this.options.single) {
      const others = this.sessions().filter(
        (s) => s !== session && s.manager.getStatus() !== 'disconnected'
      )
      await Promise.all(others.map((s) => s.manager.disconnect()))
    }
    const result = await session.manager.connect(payload)
    return { server: session.key, ...result }
  }

  /** 그 세션만 끊는다. 세션이 없으면 아무것도 하지 않는다. */
  async disconnect(key: ConnKey): Promise<void> {
    await this.byKey.get(key)?.manager.disconnect()
  }

  get(key: ConnKey): FtpSession | undefined {
    return this.byKey.get(key)
  }

  /** 연결된 세션. 키 형식이 틀리면 `Invalid connection key.`, 연결이 없으면 `FTP_NOT_CONNECTED`. */
  require(key: unknown): FtpSession {
    if (typeof key !== 'string' || parseConnKey(key) === null) {
      throw new SessionError('Invalid connection key.')
    }
    const session = this.byKey.get(key)
    if (!session?.manager.isConnected()) {
      throw new SessionError(`Not connected to ${key}.`, ErrorCode.FTP_NOT_CONNECTED)
    }
    return session
  }

  /** 알려진 모든 세션의 상태(끊긴 세션 포함), 만든 순서 */
  states(): FtpConnectionState[] {
    return this.sessions().map((s) => this.stateOf(s.key, s.manager.getStatus()))
  }

  connectedKeys(): ConnKey[] {
    return this.sessions()
      .filter((s) => s.manager.isConnected())
      .map((s) => s.key)
  }

  /** 만든 순서 */
  sessions(): FtpSession[] {
    return [...this.byKey.values()]
  }

  private ensure(key: ConnKey): FtpSession {
    const existing = this.byKey.get(key)
    if (existing) return existing
    const session = this.newSession(key)
    this.byKey.set(key, session)
    session.manager.on('connectionStatus', (status: ManagerStatus) => {
      if (status.status === 'error' && status.error) this.errors.set(key, status.error)
      else this.errors.delete(key)
      this.emit('connectionStatus', this.stateOf(key, status.status))
    })
    session.manager.on('mutation', (event: FtpMutationEvent) => {
      this.emit('mutation', { ...event, server: key } satisfies RemoteChangedEvent)
    })
    this.emit('session', session)
    return session
  }

  /** 키에서 host·port·user를 꺼낸다. 세션 키는 늘 connKey로 만들어 형식이 맞다. */
  private stateOf(key: ConnKey, status: ConnectionStatus): FtpConnectionState {
    const { host, port, user } = parseConnKey(key)!
    const error = this.errors.get(key)
    return error === undefined
      ? { server: key, status, host, port, user }
      : { server: key, status, host, port, user, error }
  }
}
