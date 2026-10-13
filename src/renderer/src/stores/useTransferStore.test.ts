import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { fallbackBatchMeta, useTransferStore } from './useTransferStore'
import { useListingStore } from './useListingStore'
import { useSettingsStore } from './useSettingsStore'
import type { Loc } from '@renderer/lib/explorerEntry'
import type { TransferJob } from '@shared/types/transfer'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

function job(id: string, overrides: Partial<TransferJob> = {}): TransferJob {
  return {
    id,
    server: 'me@nas.local:21',
    direction: 'upload',
    localPath: `/local/${id}`,
    remotePath: `/remote/${id}`,
    fileName: id,
    totalBytes: 100,
    transferredBytes: 0,
    status: 'pending',
    ...overrides
  }
}

beforeEach(() => {
  useTransferStore.setState({ jobs: [] })
})

describe('useTransferStore.applyUpdate', () => {
  it('appends upserted jobs it has not seen, in the order given', () => {
    useTransferStore.getState().applyUpdate({ upserts: [job('a'), job('b')], removedIds: [] })
    useTransferStore.getState().applyUpdate({ upserts: [job('c')], removedIds: [] })

    expect(useTransferStore.getState().jobs.map((j) => j.id)).toEqual(['a', 'b', 'c'])
  })

  it('replaces an upserted job in place and keeps the order', () => {
    useTransferStore.setState({ jobs: [job('a'), job('b'), job('c')] })

    useTransferStore.getState().applyUpdate({
      upserts: [job('b', { status: 'active', transferredBytes: 40 })],
      removedIds: []
    })

    const jobs = useTransferStore.getState().jobs
    expect(jobs.map((j) => j.id)).toEqual(['a', 'b', 'c'])
    expect(jobs[1]).toMatchObject({ status: 'active', transferredBytes: 40 })
  })

  it('leaves untouched jobs as the same objects', () => {
    const a = job('a')
    useTransferStore.setState({ jobs: [a, job('b')] })

    useTransferStore
      .getState()
      .applyUpdate({ upserts: [job('b', { status: 'active' })], removedIds: [] })

    expect(useTransferStore.getState().jobs[0]).toBe(a)
  })

  it('removes jobs listed in removedIds', () => {
    useTransferStore.setState({ jobs: [job('a'), job('b'), job('c')] })

    useTransferStore.getState().applyUpdate({ upserts: [], removedIds: ['a', 'c'] })

    expect(useTransferStore.getState().jobs.map((j) => j.id)).toEqual(['b'])
  })

  it('handles upserts and removals in one update', () => {
    useTransferStore.setState({ jobs: [job('a'), job('b')] })

    useTransferStore.getState().applyUpdate({
      upserts: [job('b', { status: 'completed' }), job('d')],
      removedIds: ['a']
    })

    const jobs = useTransferStore.getState().jobs
    expect(jobs.map((j) => j.id)).toEqual(['b', 'd'])
    expect(jobs[0].status).toBe('completed')
  })

  it('does not notify subscribers for an empty update', () => {
    let calls = 0
    const unsub = useTransferStore.subscribe(() => calls++)

    useTransferStore.getState().applyUpdate({ upserts: [], removedIds: [] })

    unsub()
    expect(calls).toBe(0)
  })
})

describe('useTransferStore.send', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    invoke.mockReset()
    vi.stubGlobal('window', { api: { invoke } })
    useTransferStore.setState({ batchMeta: {}, pendingSends: [], conflictQueue: [] })
    useSettingsStore.setState({ language: 'en' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('remembers the label and destination of a sent batch, and labels batches without one', async () => {
    // covers: Test-789
    const to: Loc = { side: 'local', path: 'C:\\dl' }
    invoke.mockResolvedValue({
      success: true,
      data: { batchId: 'b1', ids: ['j1'], skipped: [], conflicts: [], totalBytes: 100 }
    })
    const request = { direction: 'download' as const, sources: ['/p/a.jpg'], destDir: 'C:\\dl' }

    const sent = useTransferStore
      .getState()
      .send('me@nas.local:21', request, { label: 'a.jpg', to })
    expect(useTransferStore.getState().pendingSends).toEqual([
      { id: expect.any(String), label: 'a.jpg' }
    ])
    const result = await sent

    expect(invoke).toHaveBeenCalledWith('transfer:send', 'me@nas.local:21', request)
    expect(result?.batchId).toBe('b1')
    expect(useTransferStore.getState().batchMeta).toEqual({ b1: { label: 'a.jpg', to } })
    expect(useTransferStore.getState().pendingSends).toEqual([])

    // No meta (MCP, before a restart): first file name and the common destination folder.
    const jobs = [
      job('1', {
        direction: 'download',
        fileName: 'a.jpg',
        localPath: 'C:\\dl\\photos\\2024\\a.jpg'
      }),
      job('2', {
        direction: 'download',
        fileName: 'b.jpg',
        localPath: 'C:\\dl\\photos\\2025\\b.jpg'
      }),
      job('3', { direction: 'download', fileName: 'c.jpg', localPath: 'C:\\dl\\photos\\c.jpg' })
    ]
    expect(fallbackBatchMeta(jobs)).toEqual({
      label: 'a.jpg and 2 more',
      to: { side: 'local', path: 'C:\\dl\\photos' }
    })
    expect(
      fallbackBatchMeta([
        job('4', { server: 'me@h:21', remotePath: '/up/x/a.jpg', fileName: 'a.jpg' })
      ])
    ).toEqual({ label: 'a.jpg', to: { side: 'remote', path: '/up/x', server: 'me@h:21' } })

    // The fallback is fixed when the batch is first seen: a later update does not relabel it.
    const up = job('5', {
      server: 'me@h:21',
      batchId: 'b2',
      remotePath: '/up/y/b.jpg',
      fileName: 'b.jpg'
    })
    useTransferStore.getState().applyUpdate({ upserts: [up], removedIds: [] })
    useTransferStore.getState().applyUpdate({
      upserts: [{ ...up, status: 'active', remotePath: '/moved/b.jpg' }],
      removedIds: []
    })
    expect(useTransferStore.getState().batchMeta.b2).toEqual({
      label: 'b.jpg',
      to: { side: 'remote', path: '/up/y', server: 'me@h:21' }
    })
    // A batch sent from the GUI keeps its own meta.
    expect(useTransferStore.getState().batchMeta.b1).toEqual({ label: 'a.jpg', to })
  })
})

describe('useTransferStore batch meta per connection', () => {
  beforeEach(() => {
    useSettingsStore.setState({ language: 'en' })
    useTransferStore.setState({ jobs: [], batchMeta: {} })
  })

  it("labels a batch without meta by its job's connection, relay batches included", () => {
    // covers: Test-1015
    const B = 'bob@b.example.com:2121'
    // 메타 없는 업로드 배치: 목적지 서버는 그 작업의 server다(지금 연결과 무관)
    useTransferStore.getState().applyUpdate({
      upserts: [
        job('u1', { server: B, batchId: 'up', remotePath: '/in/a.jpg', fileName: 'a.jpg' }),
        job('u2', { server: B, batchId: 'up', remotePath: '/in/sub/b.jpg', fileName: 'b.jpg' })
      ],
      removedIds: []
    })
    expect(useTransferStore.getState().batchMeta.up).toEqual({
      label: 'a.jpg and 1 more',
      to: { side: 'remote', path: '/in', server: B }
    })

    // relay 배치: 받는 쪽 원격 폴더가 목적지다
    const relay = job('r1', {
      server: B,
      direction: 'relay',
      sourceServer: 'me@a.example.com:21',
      sourcePath: '/photos/x/c.jpg',
      localPath: '',
      remotePath: '/photos/x/c.jpg',
      fileName: 'c.jpg',
      batchId: 'rl'
    })
    expect(fallbackBatchMeta([relay])).toEqual({
      label: 'c.jpg',
      to: { side: 'remote', server: B, path: '/photos/x' }
    })
    useTransferStore.getState().applyUpdate({ upserts: [relay], removedIds: [] })
    expect(useTransferStore.getState().batchMeta.rl.to).toEqual({
      side: 'remote',
      server: B,
      path: '/photos/x'
    })
  })
})

describe('useTransferStore relay partial cleanup toast', () => {
  const B = 'you@b.example:2121'
  const relay = (id: string, batchId: string, overrides: Partial<TransferJob> = {}): TransferJob =>
    job(id, {
      batchId,
      direction: 'relay',
      server: B,
      sourceServer: 'me@a.example:21',
      sourcePath: `/photos/${id}`,
      localPath: '',
      remotePath: `/in/${id}`,
      fileName: id,
      ...overrides
    })
  const apply = (...upserts: TransferJob[]): void =>
    useTransferStore.getState().applyUpdate({ upserts, removedIds: [] })

  beforeEach(() => {
    vi.mocked(toast).mockClear()
    useSettingsStore.setState({ language: 'en' })
    useTransferStore.setState({ jobs: [], batchMeta: {} })
  })

  it('toasts once per batch when main reports a removed partial file, and never on a guess', () => {
    // covers: Test-1027
    apply(relay('a.jpg', 'r1', { status: 'active' }), relay('b.jpg', 'r1', { status: 'active' }))
    apply(relay('a.jpg', 'r1', { status: 'failed', error: 'x' }))
    expect(toast).not.toHaveBeenCalled()
    apply(relay('a.jpg', 'r1', { status: 'failed', error: 'x', partialRemoved: true }))
    apply(relay('a.jpg', 'r1', { status: 'failed', error: 'x', partialRemoved: true }))
    apply(relay('b.jpg', 'r1', { status: 'cancelled', partialRemoved: true }))
    expect(vi.mocked(toast).mock.calls).toEqual([
      ['Removed the incomplete copy of a.jpg on b.example:2121']
    ])

    // 지웠다는 표시가 없는 실패·취소에는 토스트가 없다
    vi.mocked(toast).mockClear()
    apply(
      relay('zero.bin', 'r2', { status: 'failed', error: `${B}: Permission denied` }),
      relay('single.bin', 'r3', {
        status: 'failed',
        error: `${B} allows only one connection, so a server-to-server copy can't run.`
      }),
      relay('gone.bin', 'r4', { status: 'cancelled' })
    )
    expect(toast).not.toHaveBeenCalled()
  })
})

describe('useTransferStore download completion', () => {
  const invalidate = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    invalidate.mockReset()
    useListingStore.setState({ invalidate })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('invalidates the local folder of completed downloads once per folder after a debounce', () => {
    // covers: Test-790
    const dl = (id: string, localPath: string, status: TransferJob['status']): TransferJob =>
      job(id, { direction: 'download', localPath, status })
    useTransferStore.setState({
      jobs: [
        dl('a', 'C:\\dl\\a.jpg', 'active'),
        dl('b', 'C:\\dl\\b.jpg', 'active'),
        dl('c', 'C:\\other\\c.jpg', 'active'),
        dl('done', 'C:\\old\\d.jpg', 'completed'),
        job('up', { status: 'active' })
      ]
    })
    const { applyUpdate } = useTransferStore.getState()

    applyUpdate({
      upserts: [dl('a', 'C:\\dl\\a.jpg', 'completed'), job('up', { status: 'completed' })],
      removedIds: []
    })
    vi.advanceTimersByTime(200)
    applyUpdate({
      upserts: [
        dl('b', 'C:\\dl\\b.jpg', 'completed'),
        dl('c', 'C:\\other\\c.jpg', 'completed'),
        // Already completed before: no new invalidation.
        dl('done', 'C:\\old\\d.jpg', 'completed')
      ],
      removedIds: []
    })
    expect(invalidate).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)
    expect(invalidate.mock.calls).toEqual([
      ['local', undefined, 'C:\\dl'],
      ['local', undefined, 'C:\\other']
    ])

    // A folder download: every folder from the file's up to the batch destination, once each.
    invalidate.mockReset()
    useTransferStore.setState({
      batchMeta: { b1: { label: 'photos', to: { side: 'local', path: 'C:\\dl' } } }
    })
    const inBatch = (id: string, localPath: string): TransferJob => ({
      ...dl(id, localPath, 'completed'),
      batchId: 'b1'
    })
    applyUpdate({
      upserts: [inBatch('x', 'C:\\dl\\photos\\2024\\x.jpg'), inBatch('y', 'C:\\dl\\photos\\y.jpg')],
      removedIds: []
    })
    vi.advanceTimersByTime(300)
    expect(invalidate.mock.calls).toEqual([
      ['local', undefined, 'C:\\dl\\photos\\2024'],
      ['local', undefined, 'C:\\dl\\photos'],
      ['local', undefined, 'C:\\dl']
    ])
  })
})
