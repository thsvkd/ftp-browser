import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Readable, Writable } from 'stream'
import { TransferHub } from './TransferHub'
import { TransferQueue } from './TransferQueue'
import { ConnectionRegistry } from '../ftp/ConnectionRegistry'
import { fakePool, fakeSession, payloadOf } from '../ftp/__fixtures__/fakeSessions'
import { createJobTracker } from '../mcp/jobTracker'
import { OperationManager } from '../operation/OperationManager'
import { LIMIT, type TransferClientPool } from './TransferClientPool'
import type { FtpFileOperations } from '../ftp/FtpFileOperations'
import type { ConnKey } from '@shared/connKey'
import type { TransferEnqueueItem, TransferJob, TransferUpdate } from '@shared/types/transfer'

const A = 'me@a.example:21'
const B = 'you@b.example:2121'

/** 원격 경로마다 끝내기를 테스트가 정하는 다운로드 */
type Pending = { resolve: () => void; reject: (err: Error) => void }

let registry: ConnectionRegistry
let hub: TransferHub
let downloads: Map<string, Pending>

beforeEach(async () => {
  vi.useFakeTimers()
  downloads = new Map()
  const fileOps = {
    download: vi.fn(
      (remotePath: string) =>
        new Promise<void>((resolve, reject) => downloads.set(remotePath, { resolve, reject }))
    )
  } as unknown as FtpFileOperations
  // 연결마다 진짜 큐 + 한도 1인 가짜 풀
  registry = new ConnectionRegistry((key: ConnKey) =>
    fakeSession(key, { queue: new TransferQueue(fileOps, fakePool(1), { server: key }) })
  )
  hub = new TransferHub(registry)
  await registry.connect(payloadOf(A))
  await registry.connect(payloadOf(B))
})

afterEach(() => {
  vi.useRealTimers()
})

const queueOf = (key: ConnKey): TransferQueue => registry.get(key)!.queue

function item(remotePath: string): TransferEnqueueItem {
  return {
    localPath: `/local${remotePath}`,
    remotePath,
    fileName: remotePath.slice(1),
    totalBytes: 1
  }
}

const statusOf = (key: ConnKey): string[] =>
  queueOf(key)
    .getAll()
    .map((job) => job.status)

describe('TransferHub', () => {
  it('lists every session queue in session order with each job tagged by its own key', async () => {
    // covers: Test-974
    const [b] = queueOf(B).enqueueBatch('download', [item('/b1')])
    const [a] = queueOf(A).enqueueBatch('download', [item('/a1')])

    const all = hub.getAll()

    expect(all.map((job) => [job.id, job.server])).toEqual([
      [a, A],
      [b, B]
    ])
  })

  it('routes cancel, retry and clearCompleted to the owning queues and ignores unknown ids', async () => {
    // covers: Test-975
    const [a1, a2] = queueOf(A).enqueueBatch('download', [item('/a1'), item('/a2')])
    const [b1] = queueOf(B).enqueueBatch('download', [item('/b1')])
    const spies = [A, B].map((key) => ({
      cancel: vi.spyOn(queueOf(key), 'cancel'),
      retry: vi.spyOn(queueOf(key), 'retry'),
      clear: vi.spyOn(queueOf(key), 'clearCompleted')
    }))
    const [onA, onB] = spies

    hub.cancel(b1)
    hub.cancel('unknown')
    expect(statusOf(B)).toEqual(['cancelled'])
    expect(statusOf(A)).toEqual(['pending', 'pending'])
    hub.retry([a1, b1, 'unknown', a2])
    hub.retry(['unknown'])
    hub.clearCompleted()

    expect(onA.cancel).not.toHaveBeenCalled()
    expect(onB.cancel.mock.calls).toEqual([[b1]])
    expect(onA.retry.mock.calls).toEqual([[[a1, a2]]])
    expect(onB.retry.mock.calls).toEqual([[[b1]]])
    expect(onA.clear).toHaveBeenCalledTimes(1)
    expect(onB.clear).toHaveBeenCalledTimes(1)
  })

  it('cancels many jobs across queues with one scan of the job lists', async () => {
    // covers: Test-1356
    const [, a2] = queueOf(A).enqueueBatch('download', [item('/a1'), item('/a2')])
    const [b1, b2] = queueOf(B).enqueueBatch('download', [item('/b1'), item('/b2')])
    const scans = [A, B].map((key) => vi.spyOn(queueOf(key), 'getAll'))

    hub.cancelMany([a2, b1, 'unknown', b2])

    expect(scans.map((scan) => scan.mock.calls.length)).toEqual([1, 1])
    expect(statusOf(A)).toEqual(['pending', 'cancelled'])
    expect(statusOf(B)).toEqual(['cancelled', 'cancelled'])
  })

  it("merges both queues' updates into one stream that the job tracker follows", async () => {
    // covers: Test-976
    const updates: TransferUpdate[] = []
    hub.on('queue:updated', (update: TransferUpdate) => updates.push(update))
    const tracker = createJobTracker(hub, new OperationManager())

    queueOf(A).enqueueBatch('download', [item('/a1')])
    const ids = queueOf(B).enqueueBatch('download', [item('/b1'), item('/b2')])
    const batchId = queueOf(B)
      .getAll()
      .find((job) => job.id === ids[0])!.batchId!
    const waiting = tracker.wait([batchId], 60_000)
    await vi.advanceTimersByTimeAsync(0)
    downloads.get('/b1')!.resolve()
    await vi.advanceTimersByTimeAsync(0)
    downloads.get('/b2')!.resolve()
    await vi.advanceTimersByTimeAsync(200)

    const servers = new Set(updates.flatMap((u) => u.upserts.map((job: TransferJob) => job.server)))
    expect(servers).toEqual(new Set([A, B]))
    await expect(waiting).resolves.toEqual([
      expect.objectContaining({ id: batchId, kind: 'batch', status: 'completed', total: 2 })
    ])
  })

  it('runs a job on another connection while a long job holds the only slot of the first', async () => {
    // covers: Test-977
    queueOf(A).enqueueBatch('download', [item('/a-long'), item('/a-next')])
    await vi.advanceTimersByTimeAsync(0)
    expect(statusOf(A)).toEqual(['active', 'pending'])

    queueOf(B).enqueueBatch('download', [item('/b1')])
    await vi.advanceTimersByTimeAsync(0)

    expect(statusOf(B)).toEqual(['active'])
    expect(statusOf(A)).toEqual(['active', 'pending'])
  })
})

describe('TransferHub with server-to-server jobs', () => {
  /** 보내는 쪽 경로 → 그 시도의 오류. 없으면 한 바이트를 보내고 끝난다 */
  let failures: Map<string, () => Error>

  /** 서버 간 전송에 쓸 수 있는 가짜 클라이언트를 한도만큼 주는 풀 */
  function relayPool(limit: number): TransferClientPool {
    let open = 0
    const client = (): object => ({
      closed: false,
      close: vi.fn(),
      trackProgress: vi.fn(),
      sendIgnoringError: vi.fn(async () => ({ code: 257, message: '257 created' })),
      downloadTo: async (writable: Writable, path: string): Promise<void> => {
        const fail = failures.get(path)
        try {
          if (fail) throw fail()
          writable.write(Buffer.from('x'))
        } finally {
          writable.end()
        }
      },
      uploadFrom: async (readable: Readable): Promise<void> => {
        for await (const chunk of readable) void chunk
      }
    })
    const give = (): void => {
      open--
    }
    return {
      limit,
      slots: limit,
      segmentedBroken: false,
      fastBroken: false,
      acquire: vi.fn(async () => {
        if (open >= limit) return LIMIT
        open++
        return client()
      }),
      release: vi.fn(give),
      discard: vi.fn(give),
      releaseAfterError: vi.fn(give),
      armIdleClose: vi.fn(),
      takeFreshLogin: vi.fn(() => true),
      probeDelay: vi.fn(() => Infinity),
      runOnMainClient: vi.fn()
    } as unknown as TransferClientPool
  }

  beforeEach(async () => {
    failures = new Map()
    const fileOps = {
      download: vi.fn(
        (remotePath: string) =>
          new Promise<void>((resolve, reject) => downloads.set(remotePath, { resolve, reject }))
      )
    } as unknown as FtpFileOperations
    // 한도 2: 큐 작업이 한 슬롯을 쥔 채로 서버 간 작업이 다른 슬롯을 빌린다
    registry = new ConnectionRegistry((key: ConnKey) =>
      fakeSession(key, { queue: new TransferQueue(fileOps, relayPool(2), { server: key }) })
    )
    hub = new TransferHub(registry)
    await registry.connect(payloadOf(A))
    await registry.connect(payloadOf(B))
  })

  it('lists relay jobs after the session queues and routes their commands to the lane', async () => {
    // covers: Test-1032
    const updates: TransferUpdate[] = []
    hub.on('queue:updated', (update: TransferUpdate) => updates.push(update))
    const tracker = createJobTracker(hub, new OperationManager())
    const [a] = queueOf(A).enqueueBatch('download', [item('/a1')])
    const [b] = queueOf(B).enqueueBatch('download', [item('/b1')])
    // 두 번째 파일은 처음엔 재시도할 수 있게 끊기고, 다음엔 재시도할 수 없게 실패한다
    failures.set('/src/r2', () =>
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    )
    const relayed = hub.enqueueRelay(
      A,
      B,
      ['r1', 'r2'].map((name) => ({
        sourcePath: `/src/${name}`,
        remotePath: `/in/${name}`,
        fileName: name,
        totalBytes: 1
      })),
      []
    )
    const [r1, r2] = relayed
    const batchId = hub.getAll().find((job) => job.id === r1)!.batchId!
    const waiting = tracker.wait([batchId], 60_000)

    expect(hub.getAll().map((job) => job.id)).toEqual([a, b, r1, r2])
    await vi.advanceTimersByTimeAsync(0)
    const status = (id: string): string | undefined => hub.getAll().find((j) => j.id === id)?.status
    expect([status(r1), status(r2)]).toEqual(['completed', 'pending'])

    // 배치의 한 작업이 남아 있으면 둘 다 남긴다
    hub.clearCompleted()
    expect(hub.getAll().map((job) => job.id)).toEqual([a, b, r1, r2])

    failures.set('/src/r2', () => Object.assign(new Error('550 Permission denied'), { code: 550 }))
    await vi.advanceTimersByTimeAsync(2100)
    expect(status(r2)).toBe('failed')
    await expect(waiting).resolves.toEqual([
      expect.objectContaining({ id: batchId, kind: 'batch', status: 'failed', total: 2 })
    ])

    // 명령은 작업을 가진 쪽으로만 간다
    const spies = [A, B].map((key) => ({
      cancel: vi.spyOn(queueOf(key), 'cancel'),
      retry: vi.spyOn(queueOf(key), 'retry')
    }))
    hub.retry([r2, a])
    expect(status(r2)).toBe('pending')
    expect(spies[0].retry.mock.calls).toEqual([[[a]]])
    expect(spies[1].retry).not.toHaveBeenCalled()
    hub.cancel(r2)
    expect(status(r2)).toBe('cancelled')
    expect(spies[0].cancel).not.toHaveBeenCalled()
    expect(spies[1].cancel).not.toHaveBeenCalled()

    // 둘 다 끝나면 둘 다 빠지고 허브의 removedIds로 알린다
    hub.clearCompleted()
    await vi.advanceTimersByTimeAsync(200)
    expect(hub.getAll().map((job) => job.id)).toEqual([a, b])
    expect(updates.flatMap((u) => u.removedIds)).toEqual(expect.arrayContaining([r1, r2]))
  })
})
