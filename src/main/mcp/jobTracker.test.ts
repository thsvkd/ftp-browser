import { describe, expect, it, vi, afterEach } from 'vitest'
import { OperationManager } from '../operation/OperationManager'
import { createJobTracker } from './jobTracker'
import { FakeQueue } from './__fixtures__/agentHarness'

afterEach(() => {
  vi.useRealTimers()
})

describe('job tracker', () => {
  it('returns once every transfer and operation id is done, or at the timeout', async () => {
    // covers: Test-410
    const queue = new FakeQueue()
    const operations = new OperationManager()
    const jobs = createJobTracker(queue, operations)
    const transfer = queue.add({ status: 'active', fileName: 'a.jpg', totalBytes: 10 })
    const op = operations.create('delete', { itemCount: 1, itemName: 'old' }, 'files', 3)
    const ids = [transfer.id, op.id, 'no-such-job']

    // 끝나지 않으면 타임아웃에 그때의 상태를 돌려준다
    const start = Date.now()
    const pending = await jobs.wait(ids, 50)
    expect(Date.now() - start).toBeGreaterThanOrEqual(45)
    expect(pending).toEqual([
      expect.objectContaining({ id: transfer.id, kind: 'transfer', status: 'active', done: false }),
      expect.objectContaining({ id: op.id, kind: 'operation', status: 'active', done: false }),
      expect.objectContaining({ id: 'no-such-job', status: 'unknown', done: true })
    ])

    // 알림이 오면 타임아웃을 기다리지 않는다
    const waiting = jobs.wait(ids, 10_000)
    queue.finish(transfer.id, 'completed')
    operations.fail(op.id, 'permission denied')
    expect(await waiting).toEqual([
      expect.objectContaining({ id: transfer.id, status: 'completed', done: true, name: 'a.jpg' }),
      expect.objectContaining({
        id: op.id,
        status: 'failed',
        done: true,
        error: 'permission denied'
      }),
      expect.objectContaining({ id: 'no-such-job', status: 'unknown', done: true })
    ])

    // 이미 모두 끝났으면 바로 돌려준다
    const again = Date.now()
    await jobs.wait(ids, 10_000)
    expect(Date.now() - again).toBeLessThan(1000)
  })

  it('still reports how a finished job ended after it left the queue or the panel', async () => {
    // covers: Test-418
    vi.useFakeTimers()
    const queue = new FakeQueue()
    const operations = new OperationManager()
    const jobs = createJobTracker(queue, operations)
    const transfer = queue.add({ status: 'active' })
    const op = operations.create('delete', { itemCount: 1 }, 'files', 1)
    queue.finish(transfer.id, 'completed')
    operations.complete(op.id)

    // OperationManager는 끝난 작업을 5초 뒤 지우고, 사용자는 전송 목록을 비울 수 있다
    vi.advanceTimersByTime(6000)
    queue.clearCompleted()
    expect(operations.getAll()).toEqual([])
    expect(queue.getAll()).toEqual([])

    expect(await jobs.wait([transfer.id, op.id], 1000)).toEqual([
      expect.objectContaining({ kind: 'transfer', status: 'completed', done: true }),
      expect.objectContaining({ kind: 'operation', status: 'completed', done: true })
    ])
  })
})
