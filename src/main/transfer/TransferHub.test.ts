import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TransferHub } from './TransferHub'
import { TransferQueue } from './TransferQueue'
import { ConnectionRegistry } from '../ftp/ConnectionRegistry'
import { fakePool, fakeSession, payloadOf } from '../ftp/__fixtures__/fakeSessions'
import { createJobTracker } from '../mcp/jobTracker'
import { OperationManager } from '../operation/OperationManager'
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
