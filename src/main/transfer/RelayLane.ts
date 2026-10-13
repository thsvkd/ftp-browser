import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { posix } from 'path'
import { PassThrough, Writable } from 'stream'
import type { Client } from 'basic-ftp'
import type { ConnKey } from '@shared/connKey'
import type { FtpMutationEvent } from '@shared/types/ftp'
import type { RelayEnqueueItem, TransferJob, TransferUpdate } from '@shared/types/transfer'
import { isRetryableError } from '../utils/errorClassifier'
import {
  FLUSH_MS,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  jobError,
  type BorrowedClient,
  type TransferQueue
} from './TransferQueue'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import type { FtpFileOperations } from '../ftp/FtpFileOperations'

/** 동시에 도는 서버 간 작업 수. 대량 배치가 한쪽 큐의 슬롯을 모두 쥐고 그 큐의 일반 전송을 굶기지 않게(MC24). */
export const MAX_RELAY_RUNNING = 4
/** 받는 쪽이 느리면 이만큼 찬 뒤 역압으로 보내는 쪽 데이터 소켓을 멈춘다(MC27). */
export const RELAY_BUFFER_BYTES = 1 << 20

export interface RelayOptions {
  maxRunning: number
}

/** 레인이 쓰는 세션의 부분. `ConnectionRegistry`가 그대로 맞는다. */
export interface RelaySession {
  manager: Pick<FtpConnectionManager, 'isConnected' | 'emit'>
  fileOps: Pick<FtpFileOperations, 'deleteFile'>
  queue: Pick<TransferQueue, 'borrow'>
}

export interface RelaySessions {
  get(key: ConnKey): RelaySession | undefined
}

/** 한 시도에서 먼저 실패한 쪽과 그 오류 */
export class RelayError extends Error {
  constructor(
    readonly side: 'source' | 'dest',
    readonly error: unknown
  ) {
    super(error instanceof Error ? error.message : String(error))
  }
}

/**
 * 한 시도. 보내는 쪽 RETR를 `PassThrough`로 받는 쪽 STOR에 잇는다(임시 파일 없음, MC23). 먼저 실패한 쪽의
 * 오류로 reject하고(`RelayError`) 다른 쪽 클라이언트는 닫는다. basic-ftp는 downloadTo의 대상을 실패해도
 * `end()`하므로(§8-1) `end()`를 넘기지 않는 문(`gate`)을 넘기고, 다운로드가 끝나고 문이 비워진 뒤에만 STOR를 끝낸다.
 */
export async function relayOnce(
  src: Client,
  dst: Client,
  sourcePath: string,
  remotePath: string,
  onProgress: (bytes: number) => void
): Promise<void> {
  const pass = new PassThrough({ highWaterMark: RELAY_BUFFER_BYTES })
  // 업로드가 먼저 끝난 뒤 destroy해도 'error' 처리기가 없어 프로세스가 죽지 않게 한다
  pass.on('error', () => {})
  const gate = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      if (pass.write(chunk)) return callback()
      const go = (): void => {
        pass.off('drain', go)
        pass.off('close', go)
        callback()
      }
      pass.on('drain', go)
      pass.on('close', go)
    }
  })
  const drained = new Promise<void>((resolve) => gate.once('finish', resolve))
  let first: RelayError | undefined
  const failed = (side: RelayError['side'], err: unknown): void => {
    first ??= new RelayError(side, err)
  }

  dst.trackProgress((info) => onProgress(info.bytesOverall))
  const up = dst.uploadFrom(pass, remotePath).then(
    () => undefined,
    (err: unknown) => {
      failed('dest', err)
      src.close()
    }
  )
  const down = src.downloadTo(gate, sourcePath).then(
    () => drained.then(() => void pass.end()),
    (err: unknown) => {
      failed('source', err)
      pass.destroy(err instanceof Error ? err : new Error(String(err)))
      dst.close()
    }
  )
  try {
    await Promise.all([up, down])
  } finally {
    dst.trackProgress()
  }
  if (first) throw first
}

/** 배치의 받는 쪽 사이 폴더와, 이미 보낸 MKD의 메모(`TransferQueue`의 BatchDirs와 같은 형태) */
interface RelayDirs {
  dirSet: Set<string>
  created: Map<string, Promise<void>>
}

const isCancelled = (job: TransferJob): boolean => job.status === 'cancelled'

/**
 * 서버 간 작업의 소유자(`TransferHub`가 쓴다, MC24~MC28·§5). 작업마다 양쪽 세션 큐에서 슬롯을 ConnKey 오름차순으로
 * 빌리고(교착 방지), 최대 `maxRunning`개를 함께 돌린다. 변경은 `queue:updated`(TransferUpdate)로 묶어 낸다.
 */
export class RelayLane extends EventEmitter {
  private jobs: TransferJob[] = []
  private byId = new Map<string, TransferJob>()
  /** 시작을 기다리는 작업(FIFO) */
  private waiting: TransferJob[] = []
  private running = 0
  private retryTimers = 0
  private dirs = new WeakMap<TransferJob, RelayDirs>()
  /** 슬롯을 빌리는 중인 작업의 취소 신호 */
  private aborts = new Map<string, AbortController>()
  /** 실행 중인 작업의 두 클라이언트. 취소는 이것을 닫아 시도를 끝낸다 */
  private clients = new Map<string, Client[]>()
  /**
   * 이번 실행(넣은 뒤 또는 사용자 재시도 뒤)의 어느 시도에서든 받는 쪽에 1바이트 이상 보낸 작업. 앞 시도가
   * 남긴 잘린 파일도 최종 실패 때 지운다(MC26: 그 STOR가 이미 원래 파일을 덮었다).
   */
  private everSent = new WeakSet<TransferJob>()
  /** 진행 중인 부분 정리. 사용자 재시도는 이것이 끝난 뒤에 시작한다(새로 보낸 파일을 지우지 않게) */
  private cleanups = new Map<string, Promise<void>>()
  private dirty = new Set<TransferJob>()
  private removedIds: string[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private maxRunning: number

  constructor(
    private sessions: RelaySessions,
    options: Partial<RelayOptions> = {}
  ) {
    super()
    this.maxRunning = options.maxRunning ?? MAX_RELAY_RUNNING
  }

  /** 강제 배치로 넣는다(파일 하나여도 배치 id). `dirs`는 받는 쪽에 먼저 만들 사이 폴더다. */
  enqueue(src: ConnKey, dst: ConnKey, items: RelayEnqueueItem[], dirs: string[]): string[] {
    if (items.length === 0) return []
    const batchId = randomUUID()
    const memo: RelayDirs = { dirSet: new Set(dirs), created: new Map() }
    const jobs = items.map(
      (item): TransferJob => ({
        id: randomUUID(),
        batchId,
        server: dst,
        sourceServer: src,
        direction: 'relay',
        sourcePath: item.sourcePath,
        localPath: '',
        remotePath: item.remotePath,
        fileName: item.fileName,
        totalBytes: item.totalBytes,
        transferredBytes: 0,
        status: 'pending'
      })
    )
    for (const job of jobs) {
      this.jobs.push(job)
      this.byId.set(job.id, job)
      this.dirs.set(job, memo)
      this.waiting.push(job)
      this.markDirty(job)
    }
    this.pump()
    return jobs.map((job) => job.id)
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  getAll(): TransferJob[] {
    return [...this.jobs]
  }

  /** 대기 중이면 빌림을 거두고, 실행 중이면 두 클라이언트를 닫는다(MC26). */
  cancel(id: string): void {
    const job = this.byId.get(id)
    if (!job || (job.status !== 'pending' && job.status !== 'active')) return
    const active = job.status === 'active'
    job.status = 'cancelled'
    this.markDirty(job)
    if (active) for (const client of this.clients.get(id) ?? []) client.close()
    else this.aborts.get(id)?.abort()
  }

  /** 실패한 작업을 같은 id·batchId로 처음부터 다시 돈다. 배치마다 MKD 메모를 새로 만든다(MC25). */
  retry(ids: string[]): void {
    const memos = new Map<string, RelayDirs>()
    for (const id of ids) {
      const job = this.byId.get(id)
      if (job?.status !== 'failed') continue
      job.status = 'pending'
      job.transferredBytes = 0
      job.error = undefined
      job.retryCount = undefined
      job.startedAt = undefined
      job.completedAt = undefined
      job.partialRemoved = undefined
      this.everSent.delete(job)
      const batch = job.batchId ?? job.id
      const old = this.dirs.get(job)!
      const memo = memos.get(batch) ?? { dirSet: old.dirSet, created: new Map() }
      memos.set(batch, memo)
      this.dirs.set(job, memo)
      this.markDirty(job)
      const cleanup = this.cleanups.get(job.id)
      if (!cleanup) {
        this.waiting.push(job)
        continue
      }
      void cleanup.then(() => {
        if (job.status === 'pending' && this.byId.has(job.id)) this.waiting.push(job)
        this.pump()
      })
    }
    this.pump()
  }

  /** 끝난 작업을 지운다. 대기·진행 중인 작업이 남은 배치는 통째로 남긴다(큐와 같다). */
  clearCompleted(): void {
    const live = new Set(
      this.jobs
        .filter((job) => job.status === 'active' || job.status === 'pending')
        .map((job) => job.batchId)
    )
    const kept: TransferJob[] = []
    for (const job of this.jobs) {
      if (live.has(job.batchId) || job.status === 'active' || job.status === 'pending') {
        kept.push(job)
        continue
      }
      this.dirty.delete(job)
      this.byId.delete(job.id)
      this.removedIds.push(job.id)
    }
    this.jobs = kept
    this.scheduleFlush()
  }

  private pump(): void {
    while (this.running < this.maxRunning && this.waiting.length > 0) {
      const job = this.waiting.shift()!
      if (job.status !== 'pending') continue
      this.running++
      void this.run(job).finally(() => {
        this.running--
        this.pump()
      })
    }
    if (this.running === 0 && this.retryTimers === 0) this.flush()
  }

  private async run(job: TransferJob): Promise<void> {
    const leases = new Map<ConnKey, BorrowedClient>()
    const borrowed = await this.borrowBoth(job, leases)
    if (borrowed !== true || isCancelled(job)) {
      for (const lease of leases.values()) lease.done()
      if (borrowed === true || isCancelled(job)) return
      if (borrowed.single) {
        // 메인 클라이언트로 긴 전송을 돌리면 그 서버의 탐색이 멈추고 취소도 못 한다(MC28). 재시도하지 않는다
        this.fail(
          job,
          `${borrowed.key} allows only one connection, so a server-to-server copy can't run. ` +
            'Download the files, then upload them.'
        )
        // 앞선 시도(FIN 재시도)가 받는 쪽에 잘린 파일을 남겼으면 지운다. 보낸 적이 없으면 아무것도 하지 않는다
        return this.cleanUpPartial(job)
      }
      return this.retryOrFail(job, borrowed.key, borrowed.err)
    }

    const source = leases.get(job.sourceServer!)!.client
    const dest = leases.get(job.server)!.client
    this.clients.set(job.id, [source, dest])
    job.status = 'active'
    job.startedAt = new Date().toISOString()
    job.transferredBytes = 0
    this.markDirty(job)

    let failure: unknown
    try {
      await this.ensureDir(dest, job, posix.dirname(job.remotePath))
      await relayOnce(source, dest, job.sourcePath!, job.remotePath, (bytes) => {
        if (bytes > 0) this.everSent.add(job)
        job.transferredBytes = bytes
        this.markDirty(job)
      })
    } catch (err) {
      failure = err
    }
    this.clients.delete(job.id)
    const side = failure instanceof RelayError && failure.side === 'source' ? 'source' : 'dest'
    const key = side === 'source' ? job.sourceServer! : job.server
    const cause = failure instanceof RelayError ? failure.error : failure
    // 실패한 쪽 임대에는 안쪽 오류를 넘겨 그 풀이 한도 응답(425·421)을 배우게 한다. 다른 쪽은 배우지 않는다
    const failed = failure !== undefined && !isCancelled(job)
    let learned = false
    for (const [leaseKey, lease] of leases) {
      if (failed && leaseKey === key) learned = lease.done(cause)
      else lease.done(failure)
    }

    if (failure === undefined && !isCancelled(job)) {
      job.transferredBytes = job.totalBytes
      job.status = 'completed'
      job.completedAt = new Date().toISOString()
      this.markDirty(job)
      // 받은 쪽 목록을 갱신한다(일반 업로드와 같다)
      this.sessions.get(job.server)?.manager.emit('mutation', {
        kind: 'upload',
        remotePath: job.remotePath
      } satisfies FtpMutationEvent)
      return
    }
    if (isCancelled(job)) {
      this.cleanUpPartial(job)
      return
    }
    if (learned) {
      // 최종 실패가 아니다: 재시도 횟수·타이머·부분 정리 없이 맨 앞에서 줄어든 풀의 빌림을 기다린다
      job.status = 'pending'
      job.transferredBytes = 0
      this.markDirty(job)
      this.waiting.unshift(job)
      return
    }
    this.retryOrFail(job, key, cause)
  }

  /**
   * 두 세션의 슬롯을 ConnKey 오름차순으로 빌린다(§8-2). 빌린 것은 `leases`에 둔다. 연결 안 됨·빌림 거절이면
   * 그 키와 오류, 보조 연결 불가(null)면 `single`.
   */
  private async borrowBoth(
    job: TransferJob,
    leases: Map<ConnKey, BorrowedClient>
  ): Promise<true | { key: ConnKey; err?: unknown; single?: true }> {
    const abort = new AbortController()
    this.aborts.set(job.id, abort)
    try {
      for (const key of [job.sourceServer!, job.server].sort()) {
        const session = this.sessions.get(key)
        if (!session?.manager.isConnected()) return { key, err: new Error('Not connected') }
        let lease: BorrowedClient | null
        try {
          lease = await session.queue.borrow(abort.signal)
        } catch (err) {
          return { key, err }
        }
        if (lease === null) return { key, single: true }
        leases.set(key, lease)
      }
      return true
    } finally {
      this.aborts.delete(job.id)
    }
  }

  /** 받는 쪽 사이 폴더를 부모부터 만든다. "이미 있음"(음수 응답)은 지나간다(ensureRemoteDir와 같다). */
  private ensureDir(client: Client, job: TransferJob, dir: string): Promise<void> {
    const memo = this.dirs.get(job)!
    if (!memo.dirSet.has(dir)) return Promise.resolve()
    const shared = memo.created.get(dir)
    if (shared) return shared
    const made = this.ensureDir(client, job, posix.dirname(dir))
      .then(() => client.sendIgnoringError(`MKD ${dir}`))
      .then((res) => {
        if (res.code >= 200 && res.code < 300) {
          this.sessions.get(job.server)?.manager.emit('mutation', {
            kind: 'mkdir',
            remotePath: dir
          } satisfies FtpMutationEvent)
        }
      })
    made.catch(() => {
      if (memo.created.get(dir) === made) memo.created.delete(dir)
    })
    memo.created.set(dir, made)
    return made
  }

  /** 재시도 가능하고 횟수가 남았으면 지연 뒤 처음부터, 아니면 실패(MC25). 오류 앞에 실패한 쪽 서버를 붙인다. */
  private retryOrFail(job: TransferJob, key: ConnKey, err: unknown): void {
    const message = `${key}: ${jobError(err)}`
    const count = job.retryCount ?? 0
    if (isRetryableError(err) && count < MAX_RETRIES) {
      job.retryCount = count + 1
      job.status = 'pending'
      job.transferredBytes = 0
      job.error = `Retry ${job.retryCount}/${MAX_RETRIES}: ${message}`
      this.markDirty(job)
      this.retryTimers++
      setTimeout(() => {
        this.retryTimers--
        if (job.status === 'pending' && this.byId.has(job.id)) this.waiting.push(job)
        this.pump()
      }, RETRY_DELAY_MS)
      return
    }
    this.fail(job, message)
    this.cleanUpPartial(job)
  }

  private fail(job: TransferJob, error: string): void {
    job.status = 'failed'
    job.error = error
    this.markDirty(job)
  }

  /** 이번 실행에서 받는 쪽에 보낸 적이 있으면(`everSent`) 부분 정리를 시작하고 재시도가 기다리게 둔다. */
  private cleanUpPartial(job: TransferJob): void {
    if (!this.everSent.has(job)) return
    const done: Promise<void> = this.removePartial(job).finally(() => {
      if (this.cleanups.get(job.id) === done) this.cleanups.delete(job.id)
    })
    this.cleanups.set(job.id, done)
  }

  /**
   * 최종 실패·취소 뒤 받는 쪽의 잘린 파일을 지운다(MC26, 최선). 지웠을 때만 `partialRemoved`, 못 지우면 오류에
   * 접미사. 그사이 사용자가 다시 시도했으면 아무것도 바꾸지 않는다.
   */
  private async removePartial(job: TransferJob): Promise<void> {
    const status = job.status
    let removed = false
    try {
      const session = this.sessions.get(job.server)
      if (!session) throw new Error('Not connected')
      await session.fileOps.deleteFile(job.remotePath)
      removed = true
    } catch {
      // 남긴다: 아래에서 오류에 적는다
    }
    if (job.status !== status) return
    if (removed) job.partialRemoved = true
    else {
      const left = `(partial file left on ${job.server})`
      job.error = job.error ? `${job.error} ${left}` : left
    }
    this.markDirty(job)
  }

  private markDirty(job: TransferJob): void {
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
    const update: TransferUpdate = {
      upserts: [...this.dirty].map((job) => ({ ...job })),
      removedIds: this.removedIds
    }
    this.dirty = new Set()
    this.removedIds = []
    this.emit('queue:updated', update)
  }
}
