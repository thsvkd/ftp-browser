import { FTPError, type Client } from 'basic-ftp'
import { DEFAULT_MAX_TRANSFERS } from '@shared/types/ftp'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'

/**
 * 전송 전용 보조 연결 수의 기본값(서버별 설정을 정하지 않았을 때). 상한은 연결 설정의
 * maxTransfers(1..20)이고 browse용 메인 클라이언트는 포함하지 않는다.
 */
export const MAX_TRANSFER_CLIENTS = DEFAULT_MAX_TRANSFERS
/** 큐가 비었을 때 idle 클라이언트를 닫기까지 기다리는 시간. 서버 슬롯 반납 + 서버 idle timeout 회피. */
export const POOL_IDLE_CLOSE_MS = 10_000

/**
 * 연결을 닫은 뒤 서버가 그 슬롯을 늦게 반납할 수 있는 시간. 이 안에 아무것도 열려 있지 않은데
 * 421이 오면 보조 로그인 불가가 아니라 반납 지연으로 보고 메인 클라이언트 fallback을 미룬다.
 */
export const RECENT_CLOSE_MS = 3000
/** 반납 지연으로 본 421 뒤 다시 로그인하기까지 기다리는 시간 */
export const LOGIN_RETRY_DELAY_MS = 500

/** 서버가 연결 수 제한을 알려 limit가 줄었음을 뜻한다. 작업 실패가 아니므로 scheduler는 항목을 큐 앞에 되돌린다. */
export const LIMIT = Symbol('TransferClientPool.LIMIT')

/** 530이 "로그인 실패"가 아니라 "연결 수 초과"일 때만 매치되도록 좁힌 메시지 패턴 */
const TOO_MANY_CONNECTIONS_RE = /too many|maximum|limit|connections/i

type PoolManager = Pick<
  FtpConnectionManager,
  'createSecondaryClient' | 'runOnMainClient' | 'getMaxTransfers' | 'on' | 'off'
>

/** 서버의 동시 접속 제한 응답인지 판단 (421, 또는 연결 수 메시지가 붙은 530) */
function isConnectionLimitError(err: unknown): boolean {
  if (!(err instanceof FTPError)) return false
  if (err.code === 421) return true
  return err.code === 530 && TOO_MANY_CONNECTIONS_RE.test(err.message)
}

/**
 * 전송용 보조 FTP 클라이언트 풀. 필요할 때 만들고(lazy) 재사용하며, 서버가 연결 수 제한을
 * 알리면 limit를 줄인다. limit는 한 번 줄면 재접속/idle close로 풀이 비워질 때까지 다시
 * 늘리지 않는다.
 *
 * scheduler 계약: 작업이 끝나면 running을 줄이기 전에 release/discard를 먼저 호출해야
 * 풀의 open 수가 limit를 넘지 않는다.
 */
export class TransferClientPool {
  private idle: Client[] = []
  private inUse = new Set<Client>()
  /** createSecondaryClient가 아직 끝나지 않은 요청 수 */
  private connecting = 0
  private _limit: number
  /** 보조 연결이 전혀 안 되는 서버: 이후 acquire는 로그인 시도 없이 null(메인 클라이언트 fallback) */
  private mainFallback = false
  /** connecting/disconnected 때마다 증가. 이전 세대에서 만들던 클라이언트는 도착 즉시 닫는다. */
  private generation = 0
  private idleTimer: NodeJS.Timeout | null = null
  /** 풀이 마지막으로 클라이언트를 닫은 시각(Date.now) */
  private lastClosedAt = -Infinity

  /** 서버가 REST를 무시해 분할 다운로드가 깨진 연결. 재접속 시 초기화된다. */
  segmentedBroken = false
  /**
   * 빠른 업로드(fastTransfer)를 받아들이지 않는 서버로 보이는 연결. 이후 업로드는 basic-ftp 표준 경로로
   * 보낸다. idle close로는 초기화하지 않고 재접속 시에만 초기화된다.
   */
  fastBroken = false

  private readonly onConnectionStatus = (state: { status: string }): void => {
    if (state.status === 'connecting' || state.status === 'disconnected') {
      this.generation++
      this.closeAll()
      this.resetLimit()
      this.segmentedBroken = false
      this.fastBroken = false
    } else if (state.status === 'connected') {
      // 연결 설정(maxTransfers)은 로그인이 끝나야 정해진다
      this.resetLimit()
    }
  }

  constructor(private manager: PoolManager) {
    this._limit = manager.getMaxTransfers()
    manager.on('connectionStatus', this.onConnectionStatus)
  }

  get limit(): number {
    return this._limit
  }

  get idleCount(): number {
    return this.idle.length
  }

  get inUseCount(): number {
    return this.inUse.size
  }

  get connectingCount(): number {
    return this.connecting
  }

  /**
   * 클라이언트를 얻는다.
   * - Client: 사용 후 release/discard 필수
   * - LIMIT: 서버 제한(또는 이미 limit만큼 열림). 항목을 큐 앞에 되돌리고 완료를 기다린다.
   * - null: 보조 연결 불가. 메인 클라이언트(runOnMainClient)로 직렬 처리해야 한다.
   * 그 외 에러(로그인 실패, 미연결 등)는 그대로 reject.
   */
  async acquire(): Promise<Client | typeof LIMIT | null> {
    this.cancelIdleClose()
    if (this.mainFallback) return null

    // 서버가 끊은 idle 클라이언트는 closed=true라 자연스럽게 건너뛴다
    while (this.idle.length > 0) {
      const client = this.idle.pop()!
      if (client.closed) continue
      this.inUse.add(client)
      return client
    }

    if (this.openCount() + this.connecting >= this._limit) return LIMIT

    const generation = this.generation
    this.connecting++
    let client: Client
    try {
      client = await this.manager.createSecondaryClient()
    } catch (err) {
      this.connecting--
      // 재접속 이후 도착한 실패는 새 세션과 무관하다
      if (generation !== this.generation || !isConnectionLimitError(err)) throw err
      if (
        this.openCount() + this.connecting === 0 &&
        Date.now() - this.lastClosedAt < RECENT_CLOSE_MS
      ) {
        // 방금 닫은 연결의 슬롯을 서버가 아직 돌려주지 않았을 수 있다. 하나로 줄이고, 그 슬롯을
        // 잡아 둔 채 잠시 뒤 다시 로그인한다. 닫은 지 RECENT_CLOSE_MS가 지나도 421이면 fallback이다.
        this._limit = 1
        this.connecting++
        await new Promise((resolve) => setTimeout(resolve, LOGIN_RETRY_DELAY_MS))
        this.connecting--
        if (generation !== this.generation) throw new Error('Not connected')
        return this.acquire()
      }
      return this.shrinkAfterLimitError()
    }
    this.connecting--

    if (generation !== this.generation) {
      client.close()
      throw new Error('Not connected')
    }
    this.inUse.add(client)
    return client
  }

  /** acquire가 null(메인 클라이언트 fallback)을 준 작업이 전송 외의 명령(MKD 등)을 메인 클라이언트에서 실행한다. */
  runOnMainClient<T>(task: (client: Client) => Promise<T>): Promise<T> {
    return this.manager.runOnMainClient(task)
  }

  /** 정상 완료된 클라이언트를 idle로 돌려놓는다. 이미 닫혔거나 풀 소유가 아니면 닫는다. */
  release(client: Client): void {
    if (!this.inUse.delete(client) || client.closed) {
      this.closeQuietly(client)
      return
    }
    this.idle.push(client)
  }

  /** 클라이언트를 닫고 풀에서 제거한다 (중단된 전송, 소켓 에러 등). */
  discard(client: Client): void {
    this.inUse.delete(client)
    this.idle = this.idle.filter((c) => c !== client)
    this.closeQuietly(client)
  }

  /**
   * 실패한 작업 뒤 클라이언트를 정리한다. FTPError(서버 응답 400+, 예: 550)이고 아직
   * 살아 있으면 세션이 온전하므로 재사용하고, 그 외에는 closeWithError로 이미 죽었으니 버린다.
   */
  releaseAfterError(client: Client, err: unknown): void {
    if (err instanceof FTPError && !client.closed) this.release(client)
    else this.discard(client)
  }

  /** 큐에 실행/대기 작업이 없을 때 호출. POOL_IDLE_CLOSE_MS 뒤 idle 클라이언트를 닫고 limit를 되돌린다. */
  armIdleClose(): void {
    this.cancelIdleClose()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      for (const client of this.idle) this.closeQuietly(client)
      this.idle = []
      // 풀이 비었을 때만 limit를 되돌린다 (사용 중인 클라이언트가 있으면 아직 진행 중)
      if (this.openCount() + this.connecting === 0) this.resetLimit()
    }, POOL_IDLE_CLOSE_MS)
    // 앱 종료를 막지 않는다
    this.idleTimer.unref?.()
  }

  cancelIdleClose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  /** 구독 해제 + 모든 클라이언트 종료 */
  dispose(): void {
    this.manager.off('connectionStatus', this.onConnectionStatus)
    this.generation++
    this.closeAll()
  }

  private openCount(): number {
    return this.idle.length + this.inUse.size
  }

  /**
   * 421/530 응답: 지금 열려 있거나 연결 중인 수를 새 limit로 삼는다. 하나도 없으면
   * 서버가 두 번째 로그인 자체를 거부하는 것이므로 메인 클라이언트 fallback(null).
   */
  private shrinkAfterLimitError(): typeof LIMIT | null {
    const alive = this.openCount() + this.connecting
    if (alive > 0) {
      this._limit = Math.max(1, Math.min(this._limit, alive))
      return LIMIT
    }
    this._limit = 1
    this.mainFallback = true
    return null
  }

  private resetLimit(): void {
    this._limit = this.manager.getMaxTransfers()
    this.mainFallback = false
  }

  private closeAll(): void {
    this.cancelIdleClose()
    for (const client of this.idle) this.closeQuietly(client)
    for (const client of this.inUse) this.closeQuietly(client)
    this.idle = []
    this.inUse.clear()
  }

  private closeQuietly(client: Client): void {
    this.lastClosedAt = Date.now()
    try {
      client.close()
    } catch {
      // 이미 닫힌 클라이언트
    }
  }
}
