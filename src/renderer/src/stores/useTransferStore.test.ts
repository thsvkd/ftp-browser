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
      ['Removed the incomplete copy of a.jpg on you@b.example:2121']
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

describe('useTransferStore transfer panel', () => {
  const invoke = vi.fn()
  const to: Loc = { side: 'remote', path: '/photos' }
  const panel = (): ReturnType<typeof useTransferStore.getState>['panel'] =>
    useTransferStore.getState().panel

  /** 답을 붙잡아 둔 보내기. 돌려준 함수로 배치 id(없으면 실패)를 답한다. */
  function startSend(label: string): (batchId?: string) => Promise<void> {
    let reply!: (result: unknown) => void
    invoke.mockImplementationOnce(() => new Promise((resolve) => (reply = resolve)))
    const sent = useTransferStore
      .getState()
      .send(
        'me@nas.local:21',
        { direction: 'upload', sources: [`/in/${label}`], destDir: '/photos' },
        { label, to }
      )
    return async (batchId) => {
      reply(
        batchId
          ? {
              success: true,
              data: { batchId, ids: ['x'], skipped: [], conflicts: [], totalBytes: 0 }
            }
          : { success: false, error: 'boom' }
      )
      await sent
    }
  }
  const sendKeys = (): string[] =>
    useTransferStore.getState().pendingSends.map((p) => `send:${p.id}`)
  const update = (...jobs: TransferJob[]): void =>
    useTransferStore.getState().applyUpdate({ upserts: jobs, removedIds: [] })

  beforeEach(() => {
    invoke.mockReset()
    vi.stubGlobal('window', { api: { invoke } })
    useSettingsStore.setState({ language: 'en' })
    useTransferStore.setState({
      jobs: [],
      batchMeta: {},
      pendingSends: [],
      conflictQueue: [],
      panel: { open: false, collapsed: false, rows: [] },
      panelMuted: [],
      panelHeld: [],
      panelSending: 0
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('links two sends with the same label to their own batches, whatever order they finish in', async () => {
    // covers: Test-1121
    const first = startSend('photos')
    const second = startSend('photos')
    const [k1, k2] = sendKeys()
    expect(panel()).toEqual({ open: true, collapsed: false, rows: [k1, k2] })

    await second('b2')
    expect(panel().rows).toEqual([k1, 'b2'])
    await first('b1')
    expect(panel().rows).toEqual(['b1', 'b2'])

    update(job('a', { batchId: 'b1', status: 'active' }), job('b', { batchId: 'b2' }))
    expect(panel()).toEqual({ open: true, collapsed: false, rows: ['b1', 'b2'] })
  })

  it('keeps the panel closed when a send closed while preparing goes live, then forgets it', async () => {
    // covers: Test-1122
    const reply = startSend('photos')
    useTransferStore.getState().closePanel()
    await reply('b1')
    expect(useTransferStore.getState().panelMuted).toEqual(['b1'])

    update(job('a', { batchId: 'b1', status: 'active' }))
    expect(panel()).toEqual({ open: false, collapsed: false, rows: [] })
    expect(useTransferStore.getState().panelMuted).toEqual([])

    // 틈(배치 id는 왔지만 첫 작업 전)에 닫아도 같다.
    const gap = startSend('again')
    await gap('b2')
    useTransferStore.getState().closePanel()
    update(job('c', { batchId: 'b2', status: 'active' }))
    expect(panel().open).toBe(false)
  })

  it('reopens expanded with only the new send after the panel was collapsed and closed', async () => {
    // covers: Test-1123
    const reply = startSend('photos')
    await reply('b1')
    update(job('a', { batchId: 'b1', status: 'active' }))
    useTransferStore.getState().togglePanelCollapsed()
    expect(panel().collapsed).toBe(true)
    useTransferStore.getState().closePanel()
    update(job('a', { batchId: 'b1', status: 'active', transferredBytes: 50 }))
    expect(panel().open).toBe(false)

    startSend('next')
    expect(panel()).toEqual({ open: true, collapsed: false, rows: sendKeys() })

    // 실패·재시도로 다시 살아난 배치는 열린 패널에 이어 붙는다(접힘 유지).
    useTransferStore.getState().togglePanelCollapsed()
    update(job('a', { batchId: 'b1', status: 'failed', error: 'x' }))
    update(job('a', { batchId: 'b1', status: 'pending' }))
    expect(panel()).toEqual({ open: true, collapsed: true, rows: [...sendKeys(), 'b1'] })
  })

  it('drops the row of a send that ends without a batch and of cleared batches', async () => {
    // covers: Test-1124
    const failed = startSend('photos')
    await failed()
    expect(panel()).toEqual({ open: true, collapsed: false, rows: [] })

    update(job('a', { batchId: 'b1', status: 'active' }), job('b', { batchId: 'b2' }))
    expect(panel().rows).toEqual(['b1', 'b2'])

    // 완료 지우기: 지운 배치의 행이 사라진다. 아직 작업이 없는 배치의 행은 남는다.
    const open = startSend('open')
    await open('b3')
    expect(panel().rows).toEqual(['b1', 'b2', 'b3'])
    useTransferStore.getState().applyUpdate({ upserts: [], removedIds: ['a'] })
    expect(panel().rows).toEqual(['b2', 'b3'])
  })

  it('keeps one row when the batch update beats the send reply, and stays closed if closed', async () => {
    // covers: Test-1125
    const reply = startSend('photos')
    const [k1] = sendKeys()
    update(job('a', { batchId: 'b1', status: 'active' }))
    expect(panel().rows).toEqual([k1])
    await reply('b1')
    expect(panel()).toEqual({ open: true, collapsed: false, rows: ['b1'] })

    // 준비 중에 닫았으면 갱신이 답보다 먼저 와도 다시 열지 않는다.
    const closed = startSend('again')
    useTransferStore.getState().closePanel()
    update(job('b', { batchId: 'b2', status: 'active' }))
    expect(panel().open).toBe(false)
    await closed('b2')
    expect(panel()).toEqual({ open: false, collapsed: false, rows: [] })
    expect(useTransferStore.getState().panelMuted).toEqual([])

    // 답을 기다리는 동안 살아난 다른 배치(MCP)는 답이 온 뒤 붙는다.
    const third = startSend('third')
    update(job('m', { batchId: 'm1', status: 'active' }))
    expect(panel().rows).toEqual(sendKeys())
    await third('b3')
    expect(panel()).toEqual({ open: true, collapsed: false, rows: ['b3', 'm1'] })
  })

  it('forgets a muted batch once its jobs show up, so a retry after a fast failure reopens', async () => {
    // covers: Test-1126
    const reply = startSend('photos')
    useTransferStore.getState().closePanel()
    await reply('b1')
    update(job('a', { batchId: 'b1', status: 'failed', error: 'denied' }))
    expect(panel().open).toBe(false)
    expect(useTransferStore.getState().panelMuted).toEqual([])

    update(job('a', { batchId: 'b1', status: 'pending' }))
    expect(panel()).toEqual({ open: true, collapsed: false, rows: ['b1'] })
  })
})
