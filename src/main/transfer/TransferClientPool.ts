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

/**
 * 아무 연결도 열려 있지 않을 때 거부된 보조 로그인을 다시 시도하기 전 기다리는 시간(차례대로).
 * 모두 거부되면 메인 클라이언트 fallback이다.
 */
export const REFUSED_LOGIN_BACKOFF_MS = [250, 500, 1000]

/**
 * 보조 로그인이 실패한 뒤 줄인 limit 위로 시험 로그인을 하기까지 처음 기다리는 시간. 실패할 때마다 두 배로
 * 늘리고(MAX_PROBE_COOLDOWN_MS까지), limit가 늘면 처음 값으로 돌아간다.
 */
export const PROBE_COOLDOWN_MS = 2000
/** 시험 로그인을 기다리는 시간의 상한 */
export const MAX_PROBE_COOLDOWN_MS = 60_000

/** 서버가 연결 수 제한을 알려 limit가 줄었음을 뜻한다. 작업 실패가 아니므로 scheduler는 항목을 큐 앞에 되돌린다. */
export const LIMIT = Symbol('TransferClientPool.LIMIT')

/** 530이 "로그인 실패"가 아니라 "연결 수 초과"일 때만 매치되도록 좁힌 메시지 패턴 */
const TOO_MANY_CONNECTIONS_RE = /too many|maximum|limit|connections/i

/** 보조 로그인의 연결 단계가 거부·끊김·시간 초과로 끝난 소켓 에러 코드 */
const REFUSED_LOGIN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'])
/** basic-ftp가 로그인 중 서버가 연결을 닫거나 응답하지 않을 때 내는 메시지 */
const UNEXPECTED_CLOSE_RE =
  /closed connection unexpectedly|sent FIN packet unexpectedly|transmission error|^Timeout \(control socket\)/

type PoolManager = Pick<
  FtpConnectionManager,
  'createSecondaryClient' | 'runOnMainClient' | 'getMaxTransfers' | 'on' | 'off'
>

/**
 * 보조 로그인이 서버에 닿지 못했는지 판단 (거부, 리셋, 시간 초과, 예기치 않은 종료). 메인 세션이 같은
 * 호스트·포트로 이미 로그인해 있으므로 주소 문제가 아니라, 동시 로그인이 몰릴 때 서버나 OS가 일부를
 * 받지 못한 것으로 보고 연결 수 제한처럼 다룬다.
 */
function isRefusedLoginError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as NodeJS.ErrnoException).code
  if (typeof code === 'string' && REFUSED_LOGIN_CODES.has(code)) return true
  return UNEXPECTED_CLOSE_RE.test(err.message)
}

/** 서버의 동시 접속 제한 응답인지 판단 (421, 또는 연결 수 메시지가 붙은 530) */
function isConnectionLimitError(err: unknown): boolean {
  if (!(err instanceof FTPError)) return false
  if (err.code === 421) return true
  return err.code === 530 && TOO_MANY_CONNECTIONS_RE.test(err.message)
}

/**
 * 전송용 보조 FTP 클라이언트 풀. 필요할 때 만들고(lazy) 재사용하며, 보조 로그인이 실패하면 limit를 줄인다.
 * - 서버가 연결 수 제한(421 등)을 알리면: 열려 있거나 연결 중인 수로 줄이고, 그 수가 재접속/idle close
 *   전까지의 상한이 된다.
 * - 다른 연결이 열린 채 보조 로그인이 거부·실패하면(530 Login incorrect 등): 열린 수로 줄인다. 아무것도
 *   열려 있지 않으면 거부는 쉬었다 다시 로그인하고, 실패는 연결 중인 수로 줄인다(한꺼번에 모두 실패하면 1).
 * 줄인 limit는 한 번에 하나뿐인 시험 로그인으로만 다시 늘린다(slots, probeDelay). 큐가 limit보다 많이
 * 돌리려 하고 대기 시간이 지났으면 acquire는 limit 위로 하나를 더 로그인한다. 되면 limit가 하나 늘고 다음
 * 시험 로그인을 바로 할 수 있다. 실패하면 limit는 그대로 두고 기다리는 시간을 두 배로 늘린다. 어떤 로그인이든
 * 실패하면 대기를 시작하고(이미 기다리는 중이면 그대로) limit 안의 로그인이 실패하면 limit가 줄므로, 처음 몰린
 * 실패 뒤로 서버가 받는 수를 넘어 실패하는 로그인은 점점 드물어지는 시험 로그인 하나씩뿐이다. 클라이언트를 잃어
 * limit 안에서 다시 로그인하는 것은 시험이 아니다.
 *
 * 감수한 비용: 클라이언트를 자주 잃는 작업(구간 다운로드는 비최종 구간마다 클라이언트를 버린다)에서 로그인이
 * 무작위로 가끔 실패하면, 다시 로그인 중인 것은 열린 수에 들지 않아 limit가 1~2까지 내려가고 시험 로그인
 * 하나씩으로만 회복해 느려진다. 실패하는 로그인 수는 끝난 작업 수에 묶이고 limit도 결국 회복한다. 연결 수
 * 메시지 없는 530으로만 막는 서버에서는 시험 로그인이 MAX_PROBE_COOLDOWN_MS마다 하나씩 계속 실패한다.
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
  /** 새로 로그인해 내준 뒤 takeFreshLogin이 아직 확인하지 않은 클라이언트 */
  private freshLogins = new WeakSet<Client>()
  /** 서버가 알린 연결 수 제한(421 등)으로 정한 limit 상한. 시험 로그인도 이것을 넘지 않는다. */
  private limitCap = Infinity
  /** limit 위로 로그인 중인 시험 로그인이 있다. connecting에 포함된다. */
  private probing = false
  /** 다음 시험 로그인을 시작할 수 있는 시각(Date.now) */
  private nextProbeAt = -Infinity
  /** 다음 실패 뒤 시험 로그인을 기다릴 시간 */
  private probeCooldown = PROBE_COOLDOWN_MS

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
   * scheduler가 함께 돌릴 수 있는 작업 수. 시험 로그인을 할 수 있거나 하는 중이면 limit에 하나를 더한다.
   * acquire가 동기적으로 바꾸므로 매번 읽는다.
   */
  get slots(): number {
    return this._limit + (this.probing || this.canProbe() ? 1 : 0)
  }

  /**
   * 다음 시험 로그인을 시작할 수 있을 때까지 남은 시간(ms). 이미 시험 중이거나 limit가 상한이면 Infinity.
   * 작업이 오래 걸려도 scheduler가 이때 다시 slots를 읽어 limit를 늘릴 수 있게 한다.
   */
  probeDelay(): number {
    if (this.probing || this._limit >= this.ceiling()) return Infinity
    return Math.max(0, this.nextProbeAt - Date.now())
  }

  /**
   * 클라이언트를 얻는다.
   * - Client: 사용 후 release/discard 필수
   * - LIMIT: 서버 제한(또는 이미 limit만큼 열림). 항목을 큐 앞에 되돌리고 완료를 기다린다.
   * - null: 보조 연결 불가. 메인 클라이언트(runOnMainClient)로 직렬 처리해야 한다.
   * 열린 연결이 없을 때의 그 외 에러(로그인 실패, 미연결 등)는 그대로 reject.
   */
  acquire(): Promise<Client | typeof LIMIT | null> {
    return this.acquireAfterRefusals(0)
  }

  /** acquire 본체. refusals는 아무 연결도 없을 때 연달아 거부된 보조 로그인 수로, 대기 시간을 고른다. */
  private async acquireAfterRefusals(refusals: number): Promise<Client | typeof LIMIT | null> {
    this.cancelIdleClose()
    if (this.mainFallback) return null

    // 서버가 끊은 idle 클라이언트는 closed=true라 자연스럽게 건너뛴다
    while (this.idle.length > 0) {
      const client = this.idle.pop()!
      if (client.closed) continue
      this.inUse.add(client)
      return client
    }

    // 시험 로그인은 limit 밖의 슬롯이다: 그동안 잃은 클라이언트는 limit 안에서 바로 대신한다
    const probe = this.openCount() + this.connecting - (this.probing ? 1 : 0) >= this._limit
    if (probe && !this.canProbe()) return LIMIT

    const generation = this.generation
    this.connecting++
    if (probe) this.probing = true
    let client: Client
    try {
      client = await this.manager.createSecondaryClient()
    } catch (err) {
      this.connecting--
      if (probe) this.probing = false
      // 재접속 이후 도착한 실패는 새 세션과 무관하다
      if (generation !== this.generation) throw err
      this.delayProbe()
      if (probe && !isConnectionLimitError(err)) {
        // limit 위의 로그인이었다: limit는 그대로 두고 열린 연결로 계속한다
        console.warn('[TransferClientPool] Probe login above the limit failed:', err)
        return LIMIT
      }
      if (isRefusedLoginError(err)) return this.afterRefusedLogin(err, generation, refusals)
      if (!isConnectionLimitError(err)) return this.afterFailedLogin(err)
      if (
        this.openCount() + this.connecting === 0 &&
        Date.now() - this.lastClosedAt < RECENT_CLOSE_MS
      ) {
        // 방금 닫은 연결의 슬롯을 서버가 아직 돌려주지 않았을 수 있다. 하나로 줄이고, 그 슬롯을
        // 잡아 둔 채 잠시 뒤 다시 로그인한다. 닫은 지 RECENT_CLOSE_MS가 지나도 421이면 fallback이다.
        this._limit = 1
        this.limitCap = 1
        this.connecting++
        await new Promise((resolve) => setTimeout(resolve, LOGIN_RETRY_DELAY_MS))
        this.connecting--
        if (generation !== this.generation) throw new Error('Not connected')
        return this.acquire()
      }
      return this.shrinkAfterLimitError()
    }
    this.connecting--
    if (probe) this.probing = false

    if (generation !== this.generation) {
      client.close()
      throw new Error('Not connected')
    }
    this.inUse.add(client)
    this.freshLogins.add(client)
    // 서버가 limit보다 많은 연결을 함께 받고 있다(시험 로그인, 또는 줄일 때 이미 연결 중이던 로그인): 그만큼
    // (상한 안에서) 늘리고 대기 시간을 처음 값으로 돌린다. 잃은 클라이언트의 자리를 채웠을 뿐이면 열린 수가
    // limit를 넘지 않아 늘리지 않는다.
    const held = Math.min(this.ceiling(), this.openCount())
    if (held > this._limit) {
      this._limit = held
      this.probeCooldown = PROBE_COOLDOWN_MS
    }
    return client
  }

  /**
   * acquire가 준 client가 idle 재사용이 아니라 새로 로그인한 연결이면 true. 클라이언트마다 한 번만 true다.
   * scheduler는 이것으로 "로그인이 된다"를 판단한다. idle 재사용은 서버가 새 로그인을 받는다는 뜻이 아니다.
   */
  takeFreshLogin(client: Client): boolean {
    return this.freshLogins.delete(client)
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
   * 거부된 보조 로그인. 다른 연결이 열려 있으면 limit를 열린 수로 줄이고 LIMIT를 돌려준다(항목은 큐 앞으로
   * 돌아가 재시도 횟수를 쓰지 않는다). 연결 중인 로그인은 세지 않는다: 함께 몰린 로그인은 함께 거부될 수
   * 있어, 세면 limit가 1까지 무너진다. 연결 중인 로그인만 있으면 줄이지 않고 LIMIT다. 아무것도 없으면
   * 슬롯을 잡아 둔 채 REFUSED_LOGIN_BACKOFF_MS만큼 쉬고 다시 로그인하고, 끝내 거부되면 메인 클라이언트
   * fallback(null)이다.
   */
  private async afterRefusedLogin(
    err: unknown,
    generation: number,
    refusals: number
  ): Promise<Client | typeof LIMIT | null> {
    console.warn('[TransferClientPool] Secondary login refused, treating it as a limit:', err)
    const open = this.openCount()
    if (open > 0) {
      this._limit = Math.min(this._limit, open)
      return LIMIT
    }
    if (this.connecting > 0) return LIMIT
    if (refusals >= REFUSED_LOGIN_BACKOFF_MS.length) return this.shrinkAfterLimitError()
    this.connecting++
    await new Promise((resolve) => setTimeout(resolve, REFUSED_LOGIN_BACKOFF_MS[refusals]))
    this.connecting--
    if (generation !== this.generation) throw new Error('Not connected')
    return this.acquireAfterRefusals(refusals + 1)
  }

  /**
   * 거부도 연결 수 제한도 아닌 이유로 실패한 보조 로그인(530 Login incorrect 등).
   * - 다른 연결이 열려 있으면 limit를 열린 수로 줄이고 LIMIT를 돌려준다: 열린 연결로 계속하고, 슬롯이 빌
   *   때마다 같은 실패를 되풀이해 로그인이 몰리지 않는다.
   * - 아무것도 열려 있지 않으면 에러를 그대로 던진다(큐가 쉬었다가 하나씩 다시 시도한다). 함께 연결 중인
   *   로그인이 있으면 limit를 그 수로 줄여, 그 로그인들이 되어 큐가 쉬는 상태를 풀어도 실패할 로그인을 다시
   *   limit만큼 몰지 않는다. 한꺼번에 모두 실패하면 limit는 1까지 줄어든다.
   * 어느 쪽이든 다시 늘리는 것은 시험 로그인이다.
   */
  private afterFailedLogin(err: unknown): typeof LIMIT {
    const open = this.openCount()
    if (open === 0) {
      if (this.connecting > 0) this._limit = Math.min(this._limit, this.connecting)
      throw err
    }
    console.warn(
      '[TransferClientPool] Secondary login failed, carrying on with the open clients:',
      err
    )
    this._limit = Math.min(this._limit, open)
    return LIMIT
  }

  /**
   * 421/530 응답: 지금 열려 있거나 연결 중인 수를 새 limit로 삼는다. 하나도 없으면
   * 서버가 두 번째 로그인 자체를 거부하는 것이므로 메인 클라이언트 fallback(null).
   */
  private shrinkAfterLimitError(): typeof LIMIT | null {
    const alive = this.openCount() + this.connecting
    if (alive > 0) {
      this._limit = Math.max(1, Math.min(this._limit, alive))
      this.limitCap = this._limit
      return LIMIT
    }
    this._limit = 1
    this.limitCap = 1
    this.mainFallback = true
    return null
  }

  /** limit를 늘릴 수 있는 상한: 설정한 전송 수와 서버가 알린 연결 수 제한 중 작은 것 */
  private ceiling(): number {
    return Math.min(this.manager.getMaxTransfers(), this.limitCap)
  }

  /** 지금 limit 위로 시험 로그인을 시작할 수 있는지 */
  private canProbe(): boolean {
    return !this.probing && this._limit < this.ceiling() && Date.now() >= this.nextProbeAt
  }

  /**
   * 보조 로그인이 실패했다: 지금부터 probeCooldown 동안 시험 로그인을 하지 않고, 다음 대기를 두 배로 늘린다.
   * 이미 기다리는 중이면 그대로 둔다. 함께 몰린 실패는 대기 하나로 세고, 기다리는 동안에는 시험 로그인이
   * 없으므로 그 사이의 실패는 limit 안의 로그인뿐이다(실패할 때마다 limit가 준다).
   */
  private delayProbe(): void {
    const now = Date.now()
    if (now < this.nextProbeAt) return
    this.nextProbeAt = now + this.probeCooldown
    this.probeCooldown = Math.min(this.probeCooldown * 2, MAX_PROBE_COOLDOWN_MS)
  }

  private resetLimit(): void {
    this._limit = this.manager.getMaxTransfers()
    this.limitCap = Infinity
    this.nextProbeAt = -Infinity
    this.probeCooldown = PROBE_COOLDOWN_MS
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
