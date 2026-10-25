import { EventEmitter } from 'events'
import { FtpConnectionManager } from './FtpConnectionManager'
import type { Client } from 'basic-ftp'
import type {
  ConnectionStatus,
  FtpConnectPayload,
  FtpConnectionState,
  FtpListResult,
  FtpMutationEvent
} from '@shared/types/ftp'

/** 로그인 페이로드에서 뽑은 세션 키(M1): 렌더러 serverKey와 같은 `"user@host:port"`. */
export function serverKeyOf(login: Pick<FtpConnectPayload, 'user' | 'host' | 'port'>): string {
  return `${login.user}@${login.host}:${login.port}`
}

/**
 * 핸들러·큐·에이전트가 "매니저 하나"에 기대는 표면. 세션을 모르는 코드는 이 타입이면
 * FtpSessionRegistry(위임)든 FtpConnectionManager든 그대로 쓴다(M3: 인자 없이 요청하면 primary).
 */
export type FtpManagerHandle = Pick<
  FtpConnectionManager,
  | 'connect'
  | 'disconnect'
  | 'list'
  | 'runOnMainClient'
  | 'createSecondaryClient'
  | 'isConnected'
  | 'getHost'
  | 'getPort'
  | 'getUser'
  | 'getStatus'
  | 'getMaxTransfers'
> &
  Pick<EventEmitter, 'on' | 'off' | 'emit'>

/**
 * 서버 키("user@host:port")별 FTP 매니저. 인자 없이 요청하면 `primary`를 쓴다(M3) —
 * MCP·아직 세션 인자를 안 넣은 호출부가 새 매니저를 만들지 않는 경로다(M9).
 *
 * 같은 키는 같은 매니저를 쓰고(Test-906), 같은 키로 다시 연결할 때 매니저가 늘어나지 않는다:
 * `FtpConnectionManager.connect`이 이전 클라이언트를 스스로 정리하므로 중복 매니저 누수도 없다(함정 C).
 *
 * 동시에 단일 매니저 자리(위임)를 겸한다: `list`·`isConnected` 같은 호출은 primary(가장 최근에
 * 연결을 시도/성공한 세션)로, 세션 매니저의 이벤트는 세션 태그(`server`)를 붙여 다시 보내므로 창
 * 하나가 여러 세션의 알림을 구분할 수 있다(M5·함정 D).
 */
export class FtpSessionRegistry extends EventEmitter implements FtpManagerHandle {
  private sessions = new Map<string, FtpConnectionManager>()
  private keys = new WeakMap<FtpConnectionManager, string>()
  /** 이벤트(연결 상태·원격 변경)를 이미 물려 둔 매니저 */
  private wired = new WeakSet<FtpConnectionManager>()
  /** M3: 가장 최근에 연결을 시도/성공한 세션. 아직 세션이 없을 땐 쓰지 않는 placeholder다. */
  private primary: FtpConnectionManager

  constructor() {
    super()
    // 인자를 안 준 호출이 바로 받을 수 있는 자리. 세션이 생기기 전에는 끊긴 상태 그대로다.
    this.primary = new FtpConnectionManager()
  }

  /** M3: 인자가 없으면 primary(새 매니저를 만들지 않는다). 있으면 그 세션, 없으면 새로 만든다. */
  get(server?: string): FtpConnectionManager {
    if (server === undefined) return this.primary
    const existing = this.sessions.get(server)
    if (existing) return existing
    const manager = new FtpConnectionManager()
    this.register(server, manager)
    return manager
  }

  /** M2: 로그인 페이로드에서 세션 키를 뽑아 매니저를 등록하고 primary로 지정한다. 반환은 세션 키. */
  put(login: FtpConnectPayload, manager: FtpConnectionManager): string {
    const key = serverKeyOf(login)
    const existing = this.sessions.get(key)
    // 함정 C: 같은 키에 다른 매니저가 들어오면 이전 매니저를 닫고 갈아낀다(중복 매니저 누수 방지)
    if (existing && existing !== manager) void existing.disconnect().catch(() => undefined)
    this.register(key, manager)
    this.primary = manager
    return key
  }

  /** M2: 같은 키의 연결은 같은 매니저로 간다. 단일 매니저 자리에서의 연결(MCP)도 이 경로다. */
  async connect(config: FtpConnectPayload): Promise<{
    success: boolean
    error?: string
    cancelled?: boolean
  }> {
    const key = serverKeyOf(config)
    const manager = this.sessions.get(key) ?? new FtpConnectionManager()
    this.put(config, manager)
    return manager.connect(config)
  }

  /** M5: 이벤트에 세션 태그를 넣기 위한 매니저 ↔ 세션 키. */
  keyOf(manager: FtpConnectionManager): string | undefined {
    return this.keys.get(manager)
  }

  /** M1/M3: 인자 없으면 primary만, 있으면 그 세션만 끊는다(나머지 세션은 살아 있다). */
  async disconnect(server?: string): Promise<void> {
    const manager = server === undefined ? this.primary : this.sessions.get(server)
    await manager?.disconnect()
  }

  /** 세션 맵에 싸고 이벤트를 물린다. 등록·primary 갱신은 여기서만 일어난다. */
  private register(key: string, manager: FtpConnectionManager): void {
    this.sessions.set(key, manager)
    this.keys.set(manager, key)
    if (this.wired.has(manager)) return
    this.wired.add(manager)
    // M5: 어느 세션의 알림인지 태그를 붙여 창으로 넘긴다(함정 D). 위임 경로의emit과 섞이지 않는다.
    manager.on('connectionStatus', (state: FtpConnectionState) => {
      this.emit('connectionStatus', { ...state, server: key })
    })
    manager.on('mutation', (event: FtpMutationEvent) => {
      this.emit('mutation', { ...event, server: key })
    })
  }

  // ---- 위임(primary 경로): 단일 매니저 자리를 그대로 쓰는 호출부가 이렇게 쓴다(M3·M9) ----

  list(remotePath: string): Promise<FtpListResult> {
    return this.primary.list(remotePath)
  }

  runOnMainClient<T>(task: (client: Client) => Promise<T>): Promise<T> {
    return this.primary.runOnMainClient(task)
  }

  createSecondaryClient(): Promise<Client> {
    return this.primary.createSecondaryClient()
  }

  isConnected(): boolean {
    return this.primary.isConnected()
  }

  getHost(): string {
    return this.primary.getHost()
  }

  getPort(): number {
    return this.primary.getPort()
  }

  getUser(): string {
    return this.primary.getUser()
  }

  getStatus(): ConnectionStatus {
    return this.primary.getStatus()
  }

  getMaxTransfers(): number {
    return this.primary.getMaxTransfers()
  }
}
