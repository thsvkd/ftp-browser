/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { createElement } from 'react'
import { toast } from 'sonner'
import { fallbackBatchMeta, useTransferStore } from './useTransferStore'
import { useListingStore } from './useListingStore'
import { useSettingsStore } from './useSettingsStore'
import { useThumbnailStore } from '@renderer/stores/useThumbnailStore'
import { ThumbnailImage } from '@renderer/components/thumbnail/ThumbnailImage'
import { invokeCalls } from '@renderer/test/rendererTestUtils'
import type { Loc } from '@renderer/lib/explorerEntry'
import type { TransferJob, TransferSendResult } from '@shared/types/transfer'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

function job(id: string, overrides: Partial<TransferJob> = {}): TransferJob {
  return {
    id,
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

    expect(invoke).toHaveBeenCalledWith('transfer:send', request)
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

describe('useTransferStore move cleanup', () => {
  const invoke = vi.fn()
  const invalidate = vi.fn()

  beforeEach(() => {
    invoke.mockReset()
    invalidate.mockReset()
    vi.mocked(toast).mockClear()
    vi.stubGlobal('window', { api: { invoke } })
    useListingStore.setState({ invalidate })
    useSettingsStore.setState({ language: 'en' })
    useTransferStore.setState({ jobs: [], batchMeta: {}, pendingSends: [], conflictQueue: [] })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** `transfer:send`는 충돌 없이 바로 큐에 넣었다고 답하게 한다. 그 외 채널은 성공. */
  function queueSend(result: Partial<TransferSendResult>): void {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'transfer:send')
        return { success: true, data: { skipped: [], conflicts: [], totalBytes: 0, ...result } }
      return { success: true }
    })
  }

  /** 이동으로 업로드를 보낸다(verbRef를 넘기면 충돌 없이도 이동으로 등록된다). */
  function sendMoveUpload(
    ids: string[],
    sources: string[],
    skipped: Array<{ path: string; reason: string }> = []
  ): Promise<TransferSendResult | null> {
    queueSend({ batchId: `batch-${ids[0]}`, ids, skipped })
    return useTransferStore
      .getState()
      .send(
        { direction: 'upload', sources, destDir: '/photos' },
        { label: 'photos', to: { side: 'remote', path: '/photos' } },
        { verb: 'move' }
      )
  }

  /** 원본 삭제 비동기 처리가 끝날 때까지 기다린다. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('deletes upload sources via local:deleteBatch and invalidates the local source folder when every job completes', async () => {
    // covers: Test-862
    await sendMoveUpload(['u862a', 'u862b'], ['C:\\src\\a.jpg', 'C:\\src\\b.jpg'])

    useTransferStore.getState().applyUpdate({
      upserts: [job('u862a', { status: 'completed' }), job('u862b', { status: 'completed' })],
      removedIds: []
    })
    await settle()

    expect(invokeCalls(invoke, 'local:deleteBatch')).toEqual([
      [['C:\\src\\a.jpg', 'C:\\src\\b.jpg']]
    ])
    expect(invalidate).toHaveBeenCalledWith('local', undefined, 'C:\\src')
  })

  it('deletes download sources via ftp:deleteBatch and invalidates the remote source folder', async () => {
    // covers: Test-863
    queueSend({ batchId: 'b863', ids: ['d863'], skipped: [] })
    await useTransferStore
      .getState()
      .send(
        { direction: 'download', sources: ['/photos/a.jpg'], destDir: 'C:\\dl' },
        { label: 'a.jpg', to: { side: 'local', path: 'C:\\dl' } },
        { verb: 'move' }
      )

    useTransferStore
      .getState()
      .applyUpdate(
        { upserts: [job('d863', { direction: 'download', status: 'completed' })], removedIds: [] },
        'me@h:21'
      )
    await settle()

    expect(invokeCalls(invoke, 'ftp:deleteBatch')).toEqual([[['/photos/a.jpg'], 'me@h:21']])
    expect(invalidate).toHaveBeenCalledWith('remote', 'me@h:21', '/photos')
    // 완료된 다운로드의 디바운스 무효화가 뒤의 테스트로 새지 않게 비운다.
    await new Promise((resolve) => setTimeout(resolve, 350))
  })

  it('deletes nothing when a job failed or was cancelled, and nothing when a single item was skipped', async () => {
    // covers: Test-864
    // (1) 하나라도 실패하면: 두 작업 중 하나가 completed여도 지우지 않는다.
    await sendMoveUpload(['f864a', 'f864b'], ['C:\\src\\a.jpg', 'C:\\src\\b.jpg'])
    useTransferStore.getState().applyUpdate({
      upserts: [job('f864a', { status: 'completed' }), job('f864b', { status: 'failed' })],
      removedIds: []
    })

    // (2) 전부 completed여도 skipped가 하나라도 있으면 지우지 않는다.
    await sendMoveUpload(
      ['s864a'],
      ['C:\\src\\a.jpg', 'C:\\src\\b.jpg'],
      [{ path: 'C:\\src\\b.jpg', reason: 'skip' }]
    )
    useTransferStore.getState().applyUpdate({
      upserts: [job('s864a', { status: 'completed' })],
      removedIds: []
    })
    await settle()

    expect(invokeCalls(invoke, 'local:deleteBatch')).toEqual([])
    expect(invokeCalls(invoke, 'ftp:deleteBatch')).toEqual([])
  })

  it('never calls a delete channel for a plain copy send without a verb', async () => {
    // covers: Test-865
    queueSend({ batchId: 'b865', ids: ['c865'], skipped: [] })
    await useTransferStore
      .getState()
      .send(
        { direction: 'upload', sources: ['C:\\src\\a.jpg'], destDir: '/photos' },
        { label: 'a.jpg', to: { side: 'remote', path: '/photos' } }
      )

    useTransferStore.getState().applyUpdate({
      upserts: [job('c865', { status: 'completed' })],
      removedIds: []
    })
    await settle()

    expect(invokeCalls(invoke, 'local:deleteBatch')).toEqual([])
    expect(invokeCalls(invoke, 'ftp:deleteBatch')).toEqual([])
  })

  it('deletes only once even when the processed batch is removed by removedIds and retried later', async () => {
    // covers: Test-866
    await sendMoveUpload(['r866'], ['C:\\src\\a.jpg'])
    const { applyUpdate } = useTransferStore.getState()

    applyUpdate({ upserts: [job('r866', { status: 'completed' })], removedIds: [] })
    await settle()
    expect(invokeCalls(invoke, 'local:deleteBatch')).toHaveLength(1)

    applyUpdate({ upserts: [], removedIds: ['r866'] })
    applyUpdate({ upserts: [job('r866', { status: 'active' })], removedIds: [] })
    applyUpdate({ upserts: [job('r866', { status: 'completed' })], removedIds: [] })
    await settle()

    expect(invokeCalls(invoke, 'local:deleteBatch')).toHaveLength(1)
  })

  it('toasts moveCleanupFailed when the delete IPC fails and never retries it', async () => {
    // covers: Test-867
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'transfer:send')
        return {
          success: true,
          data: { batchId: 'b867', ids: ['e867'], skipped: [], conflicts: [], totalBytes: 0 }
        }
      if (channel === 'local:deleteBatch') return { success: false, error: 'denied' }
      return { success: true }
    })
    await useTransferStore
      .getState()
      .send(
        { direction: 'upload', sources: ['C:\\src\\a.jpg'], destDir: '/photos' },
        { label: 'a.jpg', to: { side: 'remote', path: '/photos' } },
        { verb: 'move' }
      )

    const { applyUpdate } = useTransferStore.getState()
    applyUpdate({ upserts: [job('e867', { status: 'completed' })], removedIds: [] })
    await settle()

    expect(invokeCalls(invoke, 'local:deleteBatch')).toHaveLength(1)
    expect(vi.mocked(toast)).toHaveBeenCalledWith('Moved, but the originals could not be removed', {
      description: 'denied'
    })

    // 같은 작업을 다시 완료시켜 봐도 등록부에서 빠졌으므로 재시도하지 않는다.
    applyUpdate({ upserts: [job('e867', { status: 'completed' })], removedIds: [] })
    await settle()
    expect(invokeCalls(invoke, 'local:deleteBatch')).toHaveLength(1)
  })
})

describe('useTransferStore session keys', () => {
  const invoke = vi.fn()
  const invalidate = vi.fn()

  beforeEach(() => {
    invoke.mockReset()
    invalidate.mockReset()
    vi.mocked(toast).mockClear()
    vi.stubGlobal('window', { api: { invoke } })
    useListingStore.setState({ invalidate })
    useSettingsStore.setState({ language: 'en' })
    useTransferStore.setState({ jobs: [], batchMeta: {}, pendingSends: [], conflictQueue: [] })
    useThumbnailStore.setState({ thumbnails: {}, errors: {} })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** 원본 삭제 비동기 처리가 끝날 때까지 기다린다. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('sends the session key with transfer:send, the move-cleanup remote delete and thumbnail requests', async () => {
    // covers: Test-933
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'transfer:send')
        return {
          success: true,
          data: { batchId: 'b933', ids: ['j933'], skipped: [], conflicts: [], totalBytes: 1 }
        }
      return { success: true }
    })

    // (1) 전송: 목적지(meta.to)의 server를 보낸다(A′3 — 활성 세션이 아니라 목적지 기준).
    const request = {
      direction: 'upload' as const,
      sources: ['C:\\src\\a.jpg'],
      destDir: '/photos'
    }
    await useTransferStore.getState().send(request, {
      label: 'a.jpg',
      to: { side: 'remote', path: '/photos', server: 'other@h2:21' }
    })
    expect(invokeCalls(invoke, 'transfer:send')).toEqual([[request, 'other@h2:21']])

    // (2) 이동으로 받은 뒤의 원격 원본 삭제: 그 작업을 처리한 세션의 server를 보낸다.
    await useTransferStore
      .getState()
      .send(
        { direction: 'download', sources: ['/photos/a.jpg'], destDir: 'C:\\dl' },
        { label: 'a.jpg', to: { side: 'local', path: 'C:\\dl' } },
        { verb: 'move' }
      )
    useTransferStore
      .getState()
      .applyUpdate(
        { upserts: [job('j933', { direction: 'download', status: 'completed' })], removedIds: [] },
        'other@h2:21'
      )
    await settle()
    expect(invokeCalls(invoke, 'ftp:deleteBatch')).toEqual([[['/photos/a.jpg'], 'other@h2:21']])

    // (3) 썸네일: 항목(entry)의 server를 보낸다.
    await act(async () => {
      render(
        createElement(ThumbnailImage, {
          entry: {
            name: 'a.jpg',
            size: 1024,
            modifiedAt: '2024-05-01T10:20:30.000Z',
            server: 'other@h2:21'
          },
          remotePath: '/photos/a.jpg',
          request: true
        })
      )
    })
    expect(invokeCalls(invoke, 'thumbnail:request')).toEqual([
      [
        {
          remotePath: '/photos/a.jpg',
          fileName: 'a.jpg',
          fileSize: 1024,
          modifiedAt: '2024-05-01T10:20:30.000Z',
          priority: 1
        },
        'other@h2:21'
      ]
    ])
  })
})
