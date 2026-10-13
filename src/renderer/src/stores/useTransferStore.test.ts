import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fallbackBatchMeta, useTransferStore } from './useTransferStore'
import { currentConn } from './useFtpStore'
import { useListingStore } from './useListingStore'
import { useSettingsStore } from './useSettingsStore'
import type { Loc } from '@renderer/lib/explorerEntry'
import type { TransferJob } from '@shared/types/transfer'

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

    const sent = useTransferStore.getState().send(request, { label: 'a.jpg', to })
    expect(useTransferStore.getState().pendingSends).toEqual([
      { id: expect.any(String), label: 'a.jpg' }
    ])
    const result = await sent

    expect(invoke).toHaveBeenCalledWith('transfer:send', currentConn(), request)
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
      fallbackBatchMeta([job('4', { remotePath: '/up/x/a.jpg', fileName: 'a.jpg' })], 'me@h:21')
    ).toEqual({ label: 'a.jpg', to: { side: 'remote', path: '/up/x', server: 'me@h:21' } })

    // The fallback is fixed when the batch is first seen: a later connection does not relabel it.
    const up = job('5', { batchId: 'b2', remotePath: '/up/y/b.jpg', fileName: 'b.jpg' })
    useTransferStore.getState().applyUpdate({ upserts: [up], removedIds: [] }, 'me@h:21')
    useTransferStore
      .getState()
      .applyUpdate({ upserts: [{ ...up, status: 'active' }], removedIds: [] }, 'other@h:21')
    expect(useTransferStore.getState().batchMeta.b2).toEqual({
      label: 'b.jpg',
      to: { side: 'remote', path: '/up/y', server: 'me@h:21' }
    })
    // A batch sent from the GUI keeps its own meta.
    expect(useTransferStore.getState().batchMeta.b1).toEqual({ label: 'a.jpg', to })
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
