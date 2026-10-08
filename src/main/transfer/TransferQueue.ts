import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { open, unlink, type FileHandle } from 'fs/promises'
import { FTPError, type Client, type FTPResponse } from 'basic-ftp'
import { FtpFileOperations, type LocalFileClaim } from '../ftp/FtpFileOperations'
import { DOWNLOAD_WRITE_BUFFER, isFastFlowSuspect } from '../ftp/fastTransfer'
import { LIMIT, type TransferClientPool } from './TransferClientPool'
import {
  FAST_STREAM_BPS,
  LAN_RTT_MS,
  LAN_WRITE_BUFFER,
  planSegments,
  PROBE_MS,
  SegmentWriter,
  downloadInto,
  SEGMENT_MIN,
  type SegmentRange
} from './segmentedDownload'
import { classifyError, isRetryableError, socketErrorDetail } from '../utils/errorClassifier'
import { markSparse } from '../utils/sparseFile'
import type {
  TransferJob,
  TransferDirection,
  TransferEnqueueItem,
  TransferUpdate
} from '@shared/types/transfer'

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000
/**
 * 풀 로그인이 실패한 뒤 새 항목을 시작하지 않고 쉬는 시간. 연달아 실패할 때마다 두 배로 늘린다.
 * 로그인 실패는 작업 탓이 아니므로 작업마다 재시도/실패로 치르지 않는다.
 */
export const LOGIN_HOLD_MS = 500
/** 연달아 이만큼 로그인이 실패하면 남은 대기 작업을 그 에러 하나로 한꺼번에 실패시킨다. */
export const MAX_LOGIN_FAILURES = 4
/** 변경분을 렌더러로 내보내는 최소 간격(초당 10회). 파일 수천 개여도 IPC 부하가 O(변경된 작업)으로 묶인다. */
const FLUSH_MS = 100
/**
 * REST 명령 자체에 대한 거부 응답(RFC 959: 500/501/502, 504는 해당 인자 미구현).
 * 데이터 전에 오는 다른 응답(425, 450, 550 등)은 RETR·PASV의 것이라 REST 문제로 보지 않는다.
 */
const REST_REJECT_CODES = new Set([500, 501, 502, 504])

/** 작업에 보일 에러 메시지. 소켓 연결 에러면 어느 주소로의 연결인지 덧붙여 나중에 진단할 수 있게 한다. */
function jobError(err: unknown): string {
  const { message } = classifyError(err)
  const detail = socketErrorDetail(err)
  return detail ? `${message} (${detail})` : message
}

/** await 사이에 cancel()이 상태를 바꾸므로 대입 직후의 타입 좁히기를 피해 매번 읽는다. */
function isCancelled(job: TransferJob): boolean {
  return job.status === 'cancelled'
}

/** MKD 한 번을 보내고 서버 응답을 돌려준다. 풀 클라이언트나 메인 클라이언트 위에서 실행된다. */
type MkdSender = (dir: string) => Promise<FTPResponse>

/** 업로드 배치가 만들어야 하는 원격 디렉터리와, 이미 진행 중이거나 끝난 MKD의 메모 */
interface BatchDirs {
  dirSet: Set<string>
  created: Map<string, Promise<void>>
}

/** 구간으로 나눠 받는 다운로드 하나의 공유 상태. 모든 구간 항목이 같은 객체를 가리킨다. */
interface SegmentedDownload {
  /** ftruncate(size)로 미리 늘려 둔 로컬 파일. 구간마다 제 위치에 쓴다. */
  file: FileHandle
  /** SIZE로 받은 실제 크기 */
  size: number
  /** 아직 끝나지 않은 구간 수 */
  remaining: number
  /** 완료된 구간이 쓴 바이트 합. 모든 구간이 끝났을 때 size와 같아야 완료다. */
  written: number
  /** 지금 클라이언트 위에서 받고 있는 구간 수. 0이 되어야 파일을 닫는다. */
  running: number
  /** 완료/실패/취소/한 스트림 전환으로 분할이 끝남. 남은 구간 항목은 버린다. */
  stopped: boolean
  /** 정리가 끝나면 작업 전체를 한 스트림으로 다시 받는다 (REST 무시/거부, 이어받는 RETR 거부). */
  restart: boolean
  /** closeSegmented가 이미 시작됨. 멈춘 쪽과 마지막 구간 쪽이 모두 부를 수 있어 한 번만 돈다. */
  closing: boolean
  /** LAN이라 한 스트림으로 받기 시작했고 아직 속도를 판정하지 않음. 판정은 한 번뿐이다. */
  probing: boolean
}

/** LAN 한 스트림의 속도 측정 기준점. writer마다 따로 두어, 판정 전 재시도면 측정도 다시 시작한다. */
interface StreamProbe {
  t0?: number
  b0: number
}

/** 스케줄러가 풀 슬롯 하나에서 실행하는 단위. 보통 작업 하나가 항목 하나이고, 분할 다운로드는 구간마다 하나다. */
interface WorkItem {
  job: TransferJob
  /** 업로드 배치의 원격 디렉터리. 같은 배치의 항목이 하나의 객체를 공유한다. */
  dirs?: BatchDirs
  /**
   * 있으면 작업 전체가 아니라 이 구간만 받는다. retries는 이 구간의 재시도 횟수로,
   * 모든 구간이 한꺼번에 끊기는 순간적인 장애가 작업 전체의 재시도 한도를 다 쓰지 않게 한다.
   */
  segment?: { range: SegmentRange; state: SegmentedDownload; retries: number }
  /** 분할이 실패해 다시 넣은 작업. 연결 전체의 segmentedBroken 없이도 이 작업은 다시 나누지 않는다. */
  oneStream?: boolean
}

type SegmentItem = WorkItem & Required<Pick<WorkItem, 'segment'>>

/** enqueueBatch 옵션 */
export interface EnqueueOptions {
  /**
   * 다운로드를 배타적으로 받는다(에이전트가 넣은 작업, agent-access K4). 로컬 파일을 'wx'로 만들어 큐에 있는 사이 그 경로에
   * 생긴 파일이면 덮지 않고 그 작업만 실패하며, 취소·실패 때는 자기가 만든 파일만 지운다. GUI는 쓰지 않는다.
   */
  exclusive?: boolean
}

/** POSIX 원격 경로의 부모 디렉터리 */
function remoteParent(remotePath: string): string {
  const slash = remotePath.lastIndexOf('/')
  return slash <= 0 ? '/' : remotePath.slice(0, slash)
}

/**
 * 전송 큐. 작업을 FIFO로 꺼내 TransferClientPool의 전용 연결 위에서 최대 pool.slots개까지
 * 동시에 실행한다. 풀이 null을 주는 서버(보조 로그인 불가)에서만 메인 클라이언트로 하나씩 돈다.
 */
export class TransferQueue extends EventEmitter {
  /** UI 표시 순서 그대로의 전체 작업 */
  private queue: TransferJob[] = []
  private byId = new Map<string, TransferJob>()
  /** 실행 대기 항목. workHead로 앞에서 O(1)에 꺼낸다. */
  private work: WorkItem[] = []
  private workHead = 0
  /** 풀 슬롯을 차지하고 있는 run() 수 (클라이언트를 기다리는 중 포함) */
  private running = 0
  /** 작업 id → 전송에 쓰는 풀 클라이언트. 실행 중 취소는 이 클라이언트를 닫아 전송을 끊는다. */
  private leases = new Map<string, Set<Client>>()
  /** 아직 다시 넣지 않은 재시도 타이머 수. 남아 있으면 풀을 idle close하지 않는다. */
  private pendingRetries = 0
  /** 작업 id → 구간으로 나눠 받는 중인 다운로드. 파일을 닫을 때까지 남아 있어 취소가 찾을 수 있다. */
  private segmented = new Map<string, SegmentedDownload>()
  /** 마지막 flush 이후 바뀐 작업. Set 삽입 순서 덕에 새 작업은 enqueue 순서대로 나간다. */
  private dirty = new Set<TransferJob>()
  private removedIds: string[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** 큐가 비어 있다가 아직 어떤 작업도 active가 되지 않음. 첫 active는 주기를 기다리지 않고 바로 알린다. */
  private idle = true
  /** 풀 로그인이 연달아 실패한 회차 수. 새로 로그인한 클라이언트를 얻으면 0으로 돌아간다. */
  private loginFailures = 0
  /** 로그인 실패 뒤 쉬는 중인 타이머. 끝나면 pump한다. 도는 동안 새 항목을 시작하지 않는다. */
  private loginHold: ReturnType<typeof setTimeout> | null = null
  /** 풀이 시험 로그인을 할 수 있게 되는 때 pump하는 타이머 */
  private probeWake: ReturnType<typeof setTimeout> | null = null
  /** 배타적 다운로드 작업 → 로컬 파일 소유. 작업의 모든 시도(재시도, 구간, 한 스트림 재실행)가 공유한다. */
  private claims = new WeakMap<TransferJob, LocalFileClaim>()

  constructor(
    private fileOps: FtpFileOperations,
    private pool: TransferClientPool
  ) {
    super()
  }

  enqueue(
    direction: TransferDirection,
    localPath: string,
    remotePath: string,
    fileName: string,
    totalBytes: number
  ): string {
    return this.enqueueBatch(direction, [{ localPath, remotePath, fileName, totalBytes }])[0]
  }

  enqueueBatch(
    direction: TransferDirection,
    items: TransferEnqueueItem[],
    forceBatch = false,
    remoteDirs?: string[],
    options?: EnqueueOptions
  ): string[] {
    if (items.length === 0) return []

    const batchId = items.length > 1 || forceBatch ? randomUUID() : undefined
    const jobs: TransferJob[] = items.map((item) => ({
      id: randomUUID(),
      batchId,
      direction,
      ...item,
      transferredBytes: 0,
      status: 'pending'
    }))

    // 배치가 만들어야 할 디렉터리는 항목들이 공유하는 메모 하나로 관리한다.
    // 메모는 배치 범위라서, 탐색 중 폴더가 지워져도 낡은 채로 남지 않는다.
    const dirs: BatchDirs | undefined =
      direction === 'upload' && remoteDirs && remoteDirs.length > 0
        ? { dirSet: new Set(remoteDirs), created: new Map() }
        : undefined

    for (const job of jobs) {
      if (options?.exclusive && direction === 'download') this.claims.set(job, { created: false })
      this.queue.push(job)
      this.byId.set(job.id, job)
      this.work.push({ job, dirs })
      this.markDirty(job)
    }
    this.pump()
    return jobs.map((job) => job.id)
  }

  cancel(id: string): void {
    const job = this.byId.get(id)
    if (!job) return
    if (job.status === 'pending') {
      // 대기 항목은 꺼낼 때 건너뛴다. 클라이언트를 기다리던 중이면 run()이 확인하고 반납한다.
      job.status = 'cancelled'
      this.markDirty(job)
      return
    }
    // 메인 클라이언트로 도는 작업(lease 없음)은 닫으면 연결 끊김으로 보이므로 무시한다.
    const clients = this.leases.get(id)
    const segmented = this.segmented.get(id)
    if (job.status !== 'active' || (!clients && !segmented)) return
    job.status = 'cancelled'
    this.markDirty(job)
    // 전송 중인 소켓을 닫으면 transfer가 reject되고, run()이 취소 상태를 보고 정리한다.
    // 분할 다운로드는 모든 구간 클라이언트를 닫고, 큐에 남은 구간은 꺼낼 때 버린다.
    if (segmented) this.stopSegmented(job, segmented)
    else for (const client of clients!) client.close()
  }

  clearCompleted(): void {
    const activeBatchIds = new Set(
      this.queue
        .filter((job) => job.batchId && (job.status === 'active' || job.status === 'pending'))
        .map((job) => job.batchId as string)
    )
    const kept: TransferJob[] = []
    for (const job of this.queue) {
      const keep =
        (job.batchId !== undefined && activeBatchIds.has(job.batchId)) ||
        (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled')
      if (keep) {
        kept.push(job)
      } else {
        // 같은 주기 안에 바뀐 뒤 지워진 작업은 upsert로 다시 살아나지 않게 뺀다.
        this.dirty.delete(job)
        this.byId.delete(job.id)
        this.removedIds.push(job.id)
      }
    }
    this.queue = kept
    this.scheduleFlush()
  }

  getAll(): TransferJob[] {
    return [...this.queue]
  }

  private markDirty(job: TransferJob): void {
    // clearCompleted로 지운 작업에 늦게 온 진행률·상태 변경은 버린다. 다시 보내면 렌더러에 지울 수 없는 행이 생긴다.
    if (!this.byId.has(job.id)) return
    this.dirty.add(job)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS)
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (this.dirty.size === 0 && this.removedIds.length === 0) return

    // 이후 변경이 이미 보낸 객체를 건드리지 않도록 얕은 복사를 보낸다.
    const update: TransferUpdate = {
      upserts: [...this.dirty].map((job) => ({ ...job })),
      removedIds: this.removedIds
    }
    this.dirty = new Set()
    this.removedIds = []
    this.emit('queue:updated', update)
  }

  /** 빈 풀 슬롯만큼 대기 항목을 시작한다. 모두 끝났으면 풀의 idle close를 걸고 변경분을 바로 보낸다. */
  private pump(): void {
    // 로그인 실패 뒤 쉬는 중: 타이머가 끝나면 다시 부른다
    if (this.loginHold) return
    // 로그인이 실패한 뒤에는 하나씩만 더 시작해, 또 실패해도 회차마다 로그인 시도가 하나로 끝난다.
    // pool.slots는 acquire가 동기적으로 바꿀 수 있어 매번 읽는다.
    const cap = this.loginFailures > 0 ? this.running + 1 : Infinity
    while (this.running < Math.min(this.pool.slots, cap)) {
      const item = this.nextRunnable()
      if (!item) break
      this.running++
      void this.run(item)
    }
    this.wakeForProbe()
    if (this.running === 0 && this.pendingRetries === 0) {
      this.pool.armIdleClose()
      // 큐가 비었다: 마지막 완료를 주기(FLUSH_MS)만큼 늦게 알리지 않고 바로 보낸다
      this.idle = true
      this.flush()
    }
  }

  /**
   * 대기 항목이 남았는데 풀이 아직 시험 로그인을 하지 않으면, 할 수 있게 되는 때 다시 pump한다. 그러지
   * 않으면 줄어든 limit가 다음 작업이 끝날 때까지(긴 파일이면 수 분) 늘지 않는다.
   */
  private wakeForProbe(): void {
    if (this.probeWake || this.running === 0 || this.workHead >= this.work.length) return
    const delay = this.pool.probeDelay()
    if (delay === 0 || delay === Infinity) return
    this.probeWake = setTimeout(() => {
      this.probeWake = null
      this.pump()
    }, delay)
    this.probeWake.unref?.()
  }

  /** 취소된 항목을 건너뛰고 다음 대기 항목을 꺼낸다. */
  private nextRunnable(): WorkItem | undefined {
    while (this.workHead < this.work.length) {
      const item = this.work[this.workHead++]
      if (this.workHead === this.work.length) {
        this.work = []
        this.workHead = 0
      }
      if (this.isRunnable(item)) return item
    }
    return undefined
  }

  /** 작업 항목은 대기 중일 때, 구간 항목은 그 분할이 아직 끝나지 않았을 때(작업은 active) 실행한다. */
  private isRunnable(item: WorkItem): boolean {
    return item.segment ? !item.segment.state.stopped : item.job.status === 'pending'
  }

  private pushFront(item: WorkItem): void {
    if (this.workHead > 0) this.work[--this.workHead] = item
    else this.work.unshift(item)
  }

  private async run(item: WorkItem): Promise<void> {
    const { job } = item

    let client: Client | typeof LIMIT | null
    try {
      client = await this.pool.acquire()
    } catch (err) {
      // 로그인 실패, 미연결 등: 작업 탓이 아니므로 항목을 큐 앞에 되돌리고 큐를 잠시 쉰다
      this.onLoginFailure(item, err)
      this.finishRun()
      return
    }

    if (client === LIMIT) {
      // 서버 연결 수 제한이지 작업 실패가 아니다. 맨 앞에 되돌리고, 진행 중인 전송이 끝날 때나
      // 풀이 시험 로그인을 할 수 있게 될 때 다시 pump된다. 아무것도 안 돌고 있으면 여기서 다시 시도한다.
      this.pushFront(item)
      this.running--
      if (this.running === 0) this.pump()
      else this.wakeForProbe()
      return
    }
    // 새로 로그인했다(또는 메인 클라이언트 fallback): 로그인이 된다. 쉬는 중이거나 하나씩만 시작하던 큐,
    // 거부된 로그인이 LIMIT로 큐에 돌려보낸 슬롯을 바로 limit만큼 다시 채운다. pump는 pool.slots까지만
    // 시작하므로 돌지 않는다. idle 재사용은 로그인이 된다는 뜻이 아니라 쉬는 상태를 풀지 않는다: 풀면
    // 열린 연결이 도는 동안 실패하는 로그인이 회차마다 다시 몰린다.
    if (client === null || this.pool.takeFreshLogin(client)) {
      this.loginFailures = 0
      if (this.loginHold) clearTimeout(this.loginHold)
      this.loginHold = null
    }
    this.pump()

    if (item.segment) {
      await this.runSegment(item as SegmentItem, client)
      this.finishRun()
      return
    }

    // 클라이언트를 기다리는 사이 취소됨: 쓰지 않은 클라이언트는 그대로 돌려준다
    if (job.status !== 'pending') {
      if (client) this.pool.release(client)
      this.finishRun()
      return
    }

    // null이면 메인 클라이언트 fallback이라 lease가 없고, 실행 중 취소도 하지 않는다
    if (client) this.leases.set(job.id, new Set([client]))
    job.status = 'active'
    job.startedAt = new Date().toISOString()
    this.markDirty(job)
    if (this.idle) {
      this.idle = false
      this.flush()
    }

    try {
      const finalRange = client && !item.oneStream ? await this.startSegmented(job, client) : null
      if (finalRange) {
        // 분할 다운로드: 이 클라이언트는 마지막 구간을 받는다. 완료·실패·취소는 구간 쪽에서 처리한다.
        await this.runSegment(finalRange, client!)
        this.finishRun()
        return
      }
      await this.transfer(item, client)
      if (!isCancelled(job)) {
        job.transferredBytes = job.totalBytes
        job.status = 'completed'
        job.completedAt = new Date().toISOString()
        this.markDirty(job)
        if (client) this.pool.release(client)
      }
    } catch (err) {
      if (!isCancelled(job) && client && isFastFlowSuspect(err)) {
        // 빠른 업로드 순서를 받아들이지 않는 서버일 수 있다. 이 연결에서는 표준 경로만 쓰고, 이 작업은
        // 재시도 횟수를 쓰지 않고 맨 앞에서 바로 다시 보낸다. 표준 경로의 실패는 평소대로 재시도/실패한다.
        this.pool.fastBroken = true
        this.pool.discard(client)
        job.status = 'pending'
        job.transferredBytes = 0
        this.markDirty(job)
        this.pushFront(item)
      } else if (!isCancelled(job)) {
        if (client) this.pool.releaseAfterError(client, err)
        this.retryOrFail(item, err)
      }
    }

    this.leases.delete(job.id)
    if (isCancelled(job)) {
      // 취소로 닫은 클라이언트는 다시 쓸 수 없다
      if (client) this.pool.discard(client)
      // 받다 만 로컬 파일은 지운다. 올리다 만 원격 파일은 FileZilla처럼 남겨 둔다.
      if (job.direction === 'download') this.removePartial(job)
    }
    this.finishRun()
  }

  /** 항목 하나를 주어진 클라이언트로 전송한다. null이면 fileOps가 메인 클라이언트로 실행한다. */
  private async transfer(item: WorkItem, client: Client | null): Promise<void> {
    const { job } = item
    const onProgress = (info: { bytes: number; bytesOverall: number }): void => {
      job.transferredBytes = info.bytesOverall
      this.markDirty(job)
    }
    if (job.direction === 'download') {
      await this.fileOps.download(
        job.remotePath,
        job.localPath,
        onProgress,
        client ?? undefined,
        this.claims.get(job)
      )
    } else {
      if (item.dirs) {
        // 메인 클라이언트 fallback(client 없음)이면 MKD도 메인 클라이언트의 직렬 큐로 보낸다
        const mkd: MkdSender = client
          ? (dir) => client.sendIgnoringError(`MKD ${dir}`)
          : (dir) => this.pool.runOnMainClient((main) => main.sendIgnoringError(`MKD ${dir}`))
        await this.ensureBatchDir(mkd, remoteParent(job.remotePath), item.dirs)
        // 메인 클라이언트 fallback은 한 번에 하나만 돌아 MKD를 기다리며 멈출 다른 연결이 없다
        if (client) await this.prepareUpcomingDirs(mkd)
      }
      await this.fileOps.upload(
        job.localPath,
        job.remotePath,
        onProgress,
        client ?? undefined,
        client !== null && !this.pool.fastBroken
      )
    }
  }

  /**
   * 분할할 만한 다운로드면 SIZE로 실제 크기를 받고, 로컬 파일을 그 크기로 만든 뒤 앞 구간들을
   * 큐 맨 앞에 넣는다. 머리 항목이 받을 마지막 구간을 돌려준다. 분할하지 않으면 null이고,
   * 그러면 호출자가 같은 클라이언트로 한 스트림 다운로드를 한다.
   *
   * SIZE 응답이 LAN_RTT_MS보다 빠르면(LAN) 나누지 않고 파일 전체 [0, size)를 한 구간으로 돌려준다.
   * 그 스트림이 느리면 probeStream이 남은 부분만 나눈다.
   */
  private async startSegmented(job: TransferJob, client: Client): Promise<SegmentItem | null> {
    if (
      job.direction !== 'download' ||
      this.pool.limit < 2 ||
      this.pool.segmentedBroken ||
      job.totalBytes < SEGMENT_MIN
    ) {
      return null
    }

    let size: number
    let rtt: number
    try {
      const sent = performance.now()
      size = await client.size(job.remotePath)
      rtt = performance.now() - sent
    } catch (err) {
      // SIZE를 지원하지 않는 서버는 한 스트림으로 받는다. 취소로 끊긴 것이면 그대로 올린다.
      if (isCancelled(job)) throw err
      return null
    }
    let ranges = planSegments(size, this.pool.limit)
    if (ranges.length === 0) return null
    const lan = rtt < LAN_RTT_MS
    if (lan) ranges = [{ start: 0, end: size, final: true }]

    // 배타적 다운로드는 아직 자기 파일이 없으면 'wx'로 만든다: 큐에 있는 사이 생긴 파일이면 EEXIST로 실패한다
    const claim = this.claims.get(job)
    const file = await open(job.localPath, claim && !claim.created ? 'wx' : 'w')
    if (claim) claim.created = true
    try {
      // NTFS는 늘리기만 한 파일의 끝쪽에 처음 쓸 때 그 앞을 0으로 채우며 다른 구간의 쓰기도 막는다(512 MiB에
      // 수 초). 희소 파일은 채우지 않으므로 늘리기 전에 표시한다. 최적화일 뿐이라 실패해도 그대로 받는다.
      if (process.platform === 'win32') await markSparse(file).catch(() => false)
      await file.truncate(size)
      if (isCancelled(job)) throw new Error('Cancelled')
    } catch (err) {
      await file.close().catch(() => {})
      throw err
    }

    const state: SegmentedDownload = {
      file,
      size,
      remaining: ranges.length,
      written: 0,
      running: 0,
      stopped: false,
      restart: false,
      closing: false,
      probing: lan
    }
    this.segmented.set(job.id, state)
    // 앞 구간을 큐 맨 앞에 넣어, 비는 슬롯이 뒤의 작은 파일보다 먼저 이 구간들을 받게 한다.
    for (let i = ranges.length - 2; i >= 0; i--) {
      this.pushFront({ job, segment: { range: ranges[i], state, retries: 0 } })
    }
    this.pump()
    return { job, segment: { range: ranges[ranges.length - 1], state, retries: 0 } }
  }

  /**
   * 구간 하나를 받는다. 앞 구간은 len에서 스트림을 끊으므로 downloadTo가 reject되어도
   * len을 다 받았으면 성공이고, basic-ftp가 닫은 그 클라이언트는 버린다. 마지막 구간은
   * 226으로 자연 종료해야 성공이며 클라이언트를 풀에 돌려준다.
   */
  private async runSegment(item: SegmentItem, client: Client | null): Promise<void> {
    const { job } = item
    const { range, state } = item.segment
    if (state.stopped) {
      // 클라이언트를 기다리는 사이 분할이 끝남: 쓰지 않은 클라이언트는 그대로 돌려준다
      if (client) this.pool.release(client)
      return
    }
    if (!client) {
      // 메인 클라이언트 fallback으로 바뀐 서버에서는 구간(REST)을 받을 수 없다
      this.stopSegmented(job, state, true)
      return
    }

    state.running++
    this.addLease(job.id, client)
    const probe: StreamProbe = { b0: 0 }
    const writer = new SegmentWriter(
      state.file.fd,
      range,
      (bytes) => {
        job.transferredBytes += bytes
        this.markDirty(job)
        if (state.probing) this.probeStream(item, writer, probe)
      },
      state.probing ? LAN_WRITE_BUFFER : DOWNLOAD_WRITE_BUFFER
    )
    // 슬랩 경로는 150 전에도 쓰기를 시작한다. 제어 응답이 먼저 실패해 basic-ftp가 리스너를 뗀 뒤 그 쓰기가
    // 실패해도 프로세스가 죽지 않게 한다(downloadToFile과 같다). 전송 실패는 downloadInto가 알린다.
    writer.on('error', () => {})
    let error: unknown = null
    try {
      await downloadInto(client, writer, job.remotePath, range.start)
    } catch (err) {
      error = err
    }
    // 소켓이 먼저 끊겨도 스레드풀의 쓰기는 남아 있을 수 있다. 끝난 뒤에야 fd를 닫을 수 있다.
    await writer.stop()
    this.removeLease(job.id, client)
    state.running--

    if (!error) this.pool.release(client)
    else if (writer.complete || state.stopped) this.pool.discard(client)
    else this.pool.releaseAfterError(client, error)

    if (!state.stopped) this.settleSegment(item, writer, error)
    if (state.stopped && state.running === 0) await this.closeSegmented(job, state)
  }

  /**
   * LAN 한 스트림의 속도를 첫 쓰기 완료부터 PROBE_MS 동안 재고 한 번 판정한다. FAST_STREAM_BPS보다 느리면
   * 이미 받아 둔 끝 뒤의 남은 부분을 planSegments로 나눈다. 머리 스트림은 클라이언트를 버리지 않고 첫 조각까지
   * 이어 받고, 나머지 조각은 큐 맨 앞에 넣는다.
   */
  private probeStream(item: SegmentItem, writer: SegmentWriter, probe: StreamProbe): void {
    const { job } = item
    const { range, state } = item.segment
    const now = performance.now()
    if (probe.t0 === undefined) {
      probe.t0 = now
      probe.b0 = writer.written
      return
    }
    if (now - probe.t0 < PROBE_MS) return
    state.probing = false
    if (state.stopped) return
    if (((writer.written - probe.b0) * 1000) / (now - probe.t0) >= FAST_STREAM_BPS) return

    const pos = range.start + writer.written + writer.writableLength
    // 파일 전체가 이미 분할 기준 이상이므로 남은 부분은 크기 기준 없이 나눈다
    const rest = planSegments(state.size - pos, this.pool.limit, 0)
    if (rest.length < 2) return
    writer.splitAt(pos + rest[0].end)
    state.remaining += rest.length - 1
    for (let i = rest.length - 1; i >= 1; i--) {
      const piece = { start: pos + rest[i].start, end: pos + rest[i].end, final: rest[i].final }
      this.pushFront({ job, segment: { range: piece, state, retries: 0 } })
    }
    this.pump()
  }

  /** 끝난 구간의 결과를 반영한다: 완료 집계, REST 문제면 한 스트림 전환, 그 외 실패는 재시도/실패. */
  private settleSegment(item: SegmentItem, writer: SegmentWriter, error: unknown): void {
    const { job } = item
    const { range, state } = item.segment
    const ok = range.final ? !error && writer.complete : writer.complete
    if (ok) {
      state.written += writer.written
      state.remaining--
      if (state.remaining === 0) state.stopped = true
      return
    }

    // 최종 구간이 넘치면 서버가 REST를 무시하고 0부터 보낸 것이다. REST 자체가 거부되면
    // 한 바이트도 받기 전에 REST 거부 코드가 온다. 둘 다 이 연결에서는 분할을 쓰지 않는다.
    const restRejected =
      error instanceof FTPError &&
      range.start > 0 &&
      writer.written === 0 &&
      REST_REJECT_CODES.has(error.code)
    if (writer.overflow || restRejected) {
      this.pool.segmentedBroken = true
      this.stopSegmented(job, state, true)
      return
    }
    // basic-ftp는 REST와 RETR 중 어느 응답인지 알려 주지 않는다. REST 뒤의 RETR만 거부하는 서버
    // (ProFTPD의 451 "Append/Restart not permitted", 554 등)도 한 스트림은 받을 수 있으므로 이 작업만
    // 한 스트림으로 다시 받는다. 진짜 550·425라면 거기서 다시 나 평소대로 재시도/실패한다.
    if (error instanceof FTPError && range.start > 0 && writer.written === 0) {
      this.stopSegmented(job, state, true)
      return
    }

    // 실패한 구간이 받은 만큼은 진행률에서 빼고, 그 구간만 다시 받는다
    job.transferredBytes -= writer.written
    this.retryOrFail(item, error ?? new Error('Segment ended before its expected size'))
  }

  /**
   * 분할을 끝낸다: 구간 클라이언트를 모두 닫아 전송을 끊는다. 받고 있는 구간이 없으면 바로
   * 파일을 정리하고, 있으면 마지막 구간이 끝날 때 runSegment가 정리한다.
   */
  private stopSegmented(job: TransferJob, state: SegmentedDownload, restart = false): void {
    if (state.stopped) return
    state.stopped = true
    state.restart = restart
    for (const client of this.leases.get(job.id) ?? []) client.close()
    if (state.running === 0) void this.closeSegmented(job, state)
  }

  /**
   * 모든 구간이 멈춘 뒤 파일을 닫고, 완료 검증·한 스트림 재실행·삭제 중 하나를 한다.
   * 취소나 실패로 끝난 파일은 지운다. 미리 size로 늘려 두었으므로 남기면 크기만 서버와 같고
   * 받지 못한 곳이 0으로 찬 파일이 된다.
   */
  private async closeSegmented(job: TransferJob, state: SegmentedDownload): Promise<void> {
    if (state.closing) return
    state.closing = true
    await state.file.close().catch(() => {})
    this.segmented.delete(job.id)

    if (isCancelled(job)) {
      this.removePartial(job)
      return
    }
    if (state.remaining === 0) {
      // ftruncate로 늘린 파일의 fstat 크기는 항상 size라서, 구간이 실제로 쓴 바이트 합으로 검증한다
      if (state.written === state.size) {
        job.transferredBytes = job.totalBytes
        job.status = 'completed'
        job.completedAt = new Date().toISOString()
      } else {
        job.status = 'failed'
        job.error = 'Downloaded file size does not match the server'
        this.removePartial(job)
      }
      this.markDirty(job)
    } else if (job.status === 'failed') {
      this.removePartial(job)
    } else if (state.restart) {
      // 'w'로 다시 열어 처음부터 받으므로 구간이 써 둔 내용은 덮인다. 배타적 다운로드도 이 파일은 자기가 만든 것이다.
      // 구간이 쓴 재시도 횟수와 에러는 새 한 스트림 시도의 것이 아니므로 비운다.
      job.status = 'pending'
      job.transferredBytes = 0
      job.retryCount = undefined
      job.error = undefined
      this.markDirty(job)
      this.pushFront({ job, oneStream: true })
      this.pump()
    }
  }

  /** 받다 만 로컬 파일을 지운다. 배타적 다운로드는 자기가 만든 파일만 지운다(그 경로에 생긴 남의 파일은 둔다). */
  private removePartial(job: TransferJob): void {
    if (this.claims.get(job)?.created === false) return
    unlink(job.localPath).catch(() => {})
  }

  private addLease(jobId: string, client: Client): void {
    const clients = this.leases.get(jobId)
    if (clients) clients.add(client)
    else this.leases.set(jobId, new Set([client]))
  }

  private removeLease(jobId: string, client: Client): void {
    const clients = this.leases.get(jobId)
    clients?.delete(client)
    if (clients?.size === 0) this.leases.delete(jobId)
  }

  /**
   * 배치가 만들어야 하는 디렉터리를 부모부터 한 번씩만 MKD한다. 이미 있는 대상 폴더처럼
   * 배치 목록에 없는 경로는 바로 통과한다. 같은 디렉터리를 기다리는 작업은 하나의 MKD를 공유한다.
   * MKD가 실패하면 메모를 지워, 다음 작업이 다시 시도한다.
   *
   * 다른 작업이 보낸 MKD를 기다리다 그것이 reject되면(그 작업이 취소되어 클라이언트가 닫힘 등)
   * 실패하지 않고 자기 연결로 다시 보낸다. 작업마다 디렉터리당 MKD를 최대 한 번 만들고 자기 것이
   * 실패하면 재시도하지 않으므로, 이 되풀이는 기다리는 작업 수를 넘지 않는다.
   */
  private ensureBatchDir(mkd: MkdSender, dir: string, dirs: BatchDirs): Promise<void> {
    if (!dirs.dirSet.has(dir)) return Promise.resolve()
    const shared = dirs.created.get(dir)
    if (shared) return shared.catch(() => this.ensureBatchDir(mkd, dir, dirs))

    // "이미 있음"(음수 응답)은 sendIgnoringError가 성공으로 삼는다. 진짜 실패는 STOR에서 드러난다.
    const memo = this.ensureBatchDir(mkd, remoteParent(dir), dirs)
      .then(() => mkd(dir))
      .then((res) => {
        // 실제로 만들어졌을 때(2xx)만 알린다. 이미 있던 폴더는 탐색 캐시를 무효화할 이유가 없다.
        if (res.code >= 200 && res.code < 300) this.emit('dir:created', dir)
      })
    memo.catch(() => {
      if (dirs.created.get(dir) === memo) dirs.created.delete(dir)
    })
    dirs.created.set(dir, memo)
    return memo
  }

  /**
   * 곧 시작할 업로드(큐 앞 pool.limit개)의 디렉터리 중 아직 아무도 만들지 않은 것을 자기 STOR 전에
   * 만든다. 그러지 않으면 새 디렉터리마다 그 첫 작업들을 잡은 연결이 모두 같은 MKD를 기다리며
   * 1 RTT씩 멈춘다. 메모를 먼저 채운 한 연결만 MKD를 치르고, 이미 만들고 있는 디렉터리는 기다리지 않는다.
   * 실패는 무시한다: 메모가 지워져 그 디렉터리의 작업이 평소처럼 자기 연결로 다시 만든다.
   */
  private async prepareUpcomingDirs(mkd: MkdSender): Promise<void> {
    const upcoming = this.work.slice(this.workHead, this.workHead + this.pool.limit)
    for (const { job, dirs, segment } of upcoming) {
      if (!dirs || segment || job.status !== 'pending') continue
      const dir = remoteParent(job.remotePath)
      if (!dirs.dirSet.has(dir) || dirs.created.has(dir)) continue
      await this.ensureBatchDir(mkd, dir, dirs).catch(() => {})
    }
  }

  /**
   * 풀 로그인 실패를 처리하는 회로 차단기. 항목은 재시도 횟수를 쓰지 않고 큐 앞에 되돌리고(로그인을 기다리는
   * 사이 취소되었거나 분할이 끝난 항목은 버린다), LOGIN_HOLD_MS부터 두 배씩 늘려 가며 pump를 미룬다.
   * 함께 시작했다 함께 실패한 로그인은 한 회차로 센다. MAX_LOGIN_FAILURES회차째에도 실패하면 대기 항목을
   * 로그인 시도 없이 이 에러 하나로 모두 실패시킨다. 이전에는 작업마다 새 로그인을 시도해 곧바로 실패시켜,
   * 연결이 잠깐 거부되는 동안 큐의 상당 부분이 실패했다.
   */
  private onLoginFailure(item: WorkItem, err: unknown): void {
    if (this.isRunnable(item)) this.pushFront(item)
    if (this.loginHold) return
    this.loginFailures++
    // 메시지만으로는 어느 연결이 실패했는지 알 수 없으므로 code·syscall·address·port가 담긴 에러를 남긴다
    console.warn(
      `[TransferQueue] Transfer login failed (${this.loginFailures}/${MAX_LOGIN_FAILURES}):`,
      err
    )
    if (this.loginFailures >= MAX_LOGIN_FAILURES) {
      this.loginFailures = 0
      this.failPending(err)
      return
    }
    this.loginHold = setTimeout(
      () => {
        this.loginHold = null
        this.pump()
      },
      LOGIN_HOLD_MS * 2 ** (this.loginFailures - 1)
    )
  }

  /** 대기 항목을 모두 같은 에러로 실패시킨다. 분할 구간 항목은 그 작업과 분할을 함께 끝낸다. */
  private failPending(err: unknown): void {
    const pending = this.work.slice(this.workHead)
    this.work = []
    this.workHead = 0
    for (const item of pending) if (this.isRunnable(item)) this.fail(item, err)
  }

  /**
   * 재시도 가능한 에러면 대기로 되돌리고 RETRY_DELAY_MS 뒤 큐 끝에 다시 넣는다. 큐는 막지 않는다.
   * 구간 항목은 작업을 active로 둔 채 그 구간만 다시 넣고(재시도 횟수는 구간마다 따로 센다),
   * 실패하면 다른 구간도 멈춘다.
   */
  private retryOrFail(item: WorkItem, err: unknown): void {
    const { job, segment } = item
    const retryCount = segment ? segment.retries : (job.retryCount ?? 0)
    if (isRetryableError(err) && retryCount < MAX_RETRIES) {
      if (segment) {
        segment.retries++
        // 작업에는 가장 많이 재시도한 구간의 횟수를 보인다
        job.retryCount = Math.max(job.retryCount ?? 0, segment.retries)
      } else {
        job.retryCount = retryCount + 1
        job.status = 'pending'
        job.transferredBytes = 0
      }
      const attempt = segment ? segment.retries : job.retryCount
      job.error = `Retry ${attempt}/${MAX_RETRIES}: ${jobError(err)}`
      this.pendingRetries++
      setTimeout(() => {
        this.pendingRetries--
        if (this.isRunnable(item)) this.work.push(item)
        this.pump()
      }, RETRY_DELAY_MS)
      this.markDirty(job)
    } else {
      this.fail(item, err)
    }
  }

  private fail(item: WorkItem, err: unknown): void {
    const { job } = item
    job.status = 'failed'
    job.error = jobError(err)
    if (item.segment) this.stopSegmented(job, item.segment.state)
    this.markDirty(job)
  }

  /** 풀 계약: release/discard를 끝낸 뒤에 running을 줄이고 다음 항목을 시작한다. */
  private finishRun(): void {
    this.running--
    this.pump()
  }
}
