import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createAgentServices } from './index'
import { createHarness, type Harness } from './__fixtures__/fakes'
import type { AgentServices } from '../types'

let h: Harness
let services: AgentServices

beforeEach(() => {
  h = createHarness()
  services = createAgentServices(h.deps)
})

afterEach(() => {
  vi.useRealTimers()
  h.db.close()
})

describe('jobs.wait', () => {
  it('returns once every transfer and operation id is done, or at the timeout', async () => {
    // covers: Test-410
    const transfer = h.queue.add({ status: 'active', fileName: 'a.jpg', totalBytes: 10 })
    const op = h.operations.create('delete', { itemCount: 1, itemName: 'old' }, 'files', 3)
    const ids = [transfer.id, op.id, 'no-such-job']

    // 끝나지 않으면 타임아웃에 그때의 상태를 돌려준다
    const start = Date.now()
    const pending = await services.jobs.wait(ids, 50)
    expect(Date.now() - start).toBeGreaterThanOrEqual(45)
    expect(pending).toEqual([
      expect.objectContaining({ id: transfer.id, kind: 'transfer', status: 'active', done: false }),
      expect.objectContaining({ id: op.id, kind: 'operation', status: 'active', done: false }),
      expect.objectContaining({ id: 'no-such-job', status: 'unknown', done: true })
    ])

    // 이벤트가 오면 타임아웃을 기다리지 않는다
    const waiting = services.jobs.wait(ids, 10_000)
    h.queue.finish(transfer.id, 'completed')
    h.operations.fail(op.id, 'permission denied')
    const done = await waiting
    expect(done).toEqual([
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
    await services.jobs.wait(ids, 10_000)
    expect(Date.now() - again).toBeLessThan(1000)
  })

  it('still reports how a finished job ended after it left the queue or the panel', async () => {
    // covers: Test-418
    vi.useFakeTimers()
    const transfer = h.queue.add({ status: 'active' })
    const op = h.operations.create('delete', { itemCount: 1 }, 'files', 1)
    h.queue.finish(transfer.id, 'completed')
    h.operations.complete(op.id)

    // OperationManager는 끝난 작업을 5초 뒤 지우고, 사용자는 전송 목록을 비울 수 있다
    vi.advanceTimersByTime(6000)
    services.jobs.clearFinished()
    expect(h.operations.getAll()).toEqual([])
    expect(h.queue.getAll()).toEqual([])

    expect(services.jobs.get([transfer.id, op.id])).toEqual([
      expect.objectContaining({ kind: 'transfer', status: 'completed', done: true }),
      expect.objectContaining({ kind: 'operation', status: 'completed', done: true })
    ])
  })
})

describe('jobs.cancel', () => {
  it("cancels every running transfer and operation for 'all' and counts them", () => {
    // covers: Test-411
    const pending = h.queue.add({ status: 'pending' })
    const active = h.queue.add({ status: 'active' })
    const finished = h.queue.add({ status: 'completed' })
    const op = h.operations.create('delete', { itemCount: 2 }, 'files', 2)
    const doneOp = h.operations.create('copy', { itemCount: 1 }, 'bytes', 1)
    h.operations.complete(doneOp.id)

    expect(services.jobs.cancel('all')).toBe(3)

    expect(pending.status).toBe('cancelled')
    expect(active.status).toBe('cancelled')
    expect(finished.status).toBe('completed')
    expect(h.operations.isCancelled(op.id)).toBe(true)
    expect(h.operations.isCancelled(doneOp.id)).toBe(false)

    const other = h.queue.add({ status: 'pending' })
    const untouched = h.queue.add({ status: 'pending' })
    expect(services.jobs.cancel([other.id, 'unknown'])).toBe(1)
    expect(untouched.status).toBe('pending')
  })
})
