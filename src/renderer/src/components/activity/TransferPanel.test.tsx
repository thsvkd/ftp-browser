/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import { batchProgress } from '@renderer/lib/transferRate'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useOperationStore } from '@renderer/stores/useOperationStore'
import type { TransferJob } from '@shared/types/transfer'
import { TransferPanel } from './TransferPanel'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

const mockInvoke = vi.fn()

function job(id: string, overrides: Partial<TransferJob> = {}): TransferJob {
  return {
    id,
    server: PHOTOS.server,
    direction: 'upload',
    localPath: `C:\\in\\${id}`,
    remotePath: `/photos/${id}`,
    fileName: id,
    totalBytes: 100,
    transferredBytes: 0,
    status: 'pending',
    ...overrides
  }
}

const DL = { side: 'local' as const, path: 'C:\\dl' }
const PHOTOS = { side: 'remote' as const, path: '/photos', server: 'me@nas:21' }

const region = (): HTMLElement | null => screen.queryByRole('region', { name: 'Transfers' })
const listButton = (): HTMLElement => screen.getByRole('button', { name: 'Transfer list' })
const group = (name: string): HTMLElement => screen.getByRole('group', { name })

/** 메인이 보낸 변경분(`transfer:updated`)처럼 스토어에 넣는다. */
const update = (...upserts: TransferJob[]): void =>
  act(() => useTransferStore.getState().applyUpdate({ upserts, removedIds: [] }))
const remove = (...removedIds: string[]): void =>
  act(() => useTransferStore.getState().applyUpdate({ upserts: [], removedIds }))
const meta = (labels: Record<string, string>): void =>
  useTransferStore.setState({
    batchMeta: Object.fromEntries(
      Object.entries(labels).map(([key, label]) => [key, { label, to: PHOTOS }])
    )
  })

/** `transfer:send`의 답을 붙잡아 둔 보내기. 돌려준 함수로 배치 id(없으면 실패)를 답한다. */
function startSend(label: string): (batchId?: string) => Promise<void> {
  let reply!: (result: unknown) => void
  mockInvoke.mockImplementationOnce(() => new Promise((resolve) => (reply = resolve)))
  let sent!: Promise<unknown>
  act(() => {
    sent = useTransferStore.getState().send(
      PHOTOS.server,
      { direction: 'upload', sources: [`C:\\in\\${label}`], destDir: '/photos' },
      {
        label,
        to: PHOTOS
      }
    )
  })
  return async (batchId) => {
    await act(async () => {
      reply(
        batchId
          ? {
              success: true,
              data: { batchId, ids: ['x'], skipped: [], conflicts: [], totalBytes: 0 }
            }
          : { success: false, error: 'boom' }
      )
      await sent
    })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockResolvedValue({ success: true })
  vi.stubGlobal('api', makeApiMock(mockInvoke))
  useTransferStore.setState({
    jobs: [],
    rates: {},
    pendingSends: [],
    batchMeta: {},
    conflictQueue: [],
    panel: { open: false, collapsed: false, rows: [] },
    panelMuted: [],
    panelHeld: [],
    panelSending: 0
  })
  useOperationStore.setState({ jobs: [] })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TransferPanel visibility', () => {
  it('stays hidden without transfers, with finished jobs only and for file operations', () => {
    // covers: Test-1107
    meta({ b1: 'old' })
    render(<TransferPanel />)
    expect(region()).toBeNull()
    update(job('a', { batchId: 'b1', status: 'completed', transferredBytes: 100 }))
    expect(region()).toBeNull()

    act(() =>
      useOperationStore.setState({
        jobs: [
          {
            id: 'op1',
            kind: 'delete',
            itemCount: 1,
            itemName: 'x.jpg',
            unit: 'files',
            total: 1,
            completed: 0,
            status: 'active'
          }
        ]
      })
    )
    expect(region()).toBeNull()

    startSend('photos')
    expect(region()).not.toBeNull()
    expect(screen.queryByText('Deleting x.jpg')).toBeNull()
    expect(within(region()!).queryByText(/delet/i)).toBeNull()
  })

  it('opens expanded on a new send without taking focus, ignores Escape and names its controls', async () => {
    // covers: Test-1108
    render(
      <>
        <button type="button">outside</button>
        <TransferPanel />
      </>
    )
    const user = userEvent.setup()
    const outside = screen.getByRole('button', { name: 'outside' })
    outside.focus()

    startSend('photos')

    expect(region()).not.toBeNull()
    expect(listButton().getAttribute('aria-expanded')).toBe('true')
    expect(within(region()!).getByText('Preparing photos…')).toBeTruthy()
    expect(within(region()!).getByText('Preparing 1 item')).toBeTruthy()
    expect(document.activeElement).toBe(outside)
    expect(region()!.hasAttribute('data-region')).toBe(false)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(region()).not.toBeNull()

    const body = listButton().getAttribute('aria-controls')!
    expect(document.getElementById(body)).not.toBeNull()
    expect(listButton().getAttribute('title')).toBe('Collapse')
    await user.click(listButton())
    expect(listButton().getAttribute('title')).toBe('Expand')
    expect(screen.getByRole('button', { name: 'Close transfer panel' }).getAttribute('title')).toBe(
      'Close transfer panel'
    )
  })
})

describe('TransferPanel summary', () => {
  it('counts running rows by direction and draws the overall progress of running batches', async () => {
    // covers: Test-1109
    render(<TransferPanel />)
    const up1 = [
      job('a', { batchId: 'u1', status: 'active', transferredBytes: 40 }),
      job('b', { batchId: 'u1', status: 'completed', transferredBytes: 100 })
    ]
    const up2 = [job('c', { batchId: 'u2', status: 'pending' })]
    meta({ u1: 'one', u2: 'two' })
    update(...up1, ...up2)
    expect(within(region()!).getByText('Uploading 2 items')).toBeTruthy()
    const bar = within(region()!).getByRole('progressbar', { name: 'Overall transfer progress' })
    expect(bar.getAttribute('aria-valuenow')).toBe(String(batchProgress([...up1, ...up2]).percent))

    // 준비 중 1 + 업로드 배치 1
    remove('c')
    const next = startSend('next')
    expect(within(region()!).getByText('Uploading 2 items')).toBeTruthy()

    // 업로드·다운로드가 섞인다
    await next()
    update(job('d', { batchId: 'd1', direction: 'download', status: 'active' }))
    expect(within(region()!).getByText('Transferring 2 items')).toBeTruthy()

    // 다운로드만, 준비 중만
    act(() =>
      useTransferStore.setState({ jobs: [], panel: { open: false, collapsed: false, rows: [] } })
    )
    const reply = startSend('a')
    expect(within(region()!).getByText('Preparing 1 item')).toBeTruthy()
    expect(within(region()!).queryByRole('progressbar')).toBeNull()

    await reply('d1')
    update(job('d', { batchId: 'd1', direction: 'download', status: 'active' }))
    expect(within(region()!).getByText('Downloading 1 item')).toBeTruthy()

    // 서버 간 복사만: 올리기도 받기도 아니다
    act(() =>
      useTransferStore.setState({ jobs: [], panel: { open: false, collapsed: false, rows: [] } })
    )
    update(
      job('r', {
        batchId: 'r1',
        direction: 'relay',
        sourceServer: 'you@b.example:2121',
        sourcePath: '/x/r',
        localPath: '',
        status: 'active'
      })
    )
    expect(within(region()!).getByText('Transferring 1 item')).toBeTruthy()
  })

  it('summarises finished rows: failed first, then complete, then cancelled; no overall bar', () => {
    // covers: Test-1110
    render(<TransferPanel />)
    meta({ b1: 'one', b2: 'two', b3: 'three' })
    update(job('a', { batchId: 'b1', status: 'active' }), job('b', { batchId: 'b2' }))
    update(
      job('a', { batchId: 'b1', status: 'completed', transferredBytes: 100 }),
      job('b', { batchId: 'b2', status: 'completed', transferredBytes: 100 })
    )
    expect(within(region()!).getByText('2 transfers complete')).toBeTruthy()
    expect(within(region()!).queryByRole('progressbar')).toBeNull()

    update(job('b', { batchId: 'b2', status: 'failed', error: 'boom' }))
    expect(within(region()!).getByText('1 transfer failed')).toBeTruthy()

    update(
      job('a', { batchId: 'b1', status: 'cancelled' }),
      job('b', { batchId: 'b2', status: 'cancelled' })
    )
    expect(within(region()!).getByText('2 transfers cancelled')).toBeTruthy()
  })
})

describe('TransferPanel rows', () => {
  it('shows destination, progress, time left, finishing, outcome texts and retries failures', async () => {
    // covers: Test-1111
    render(<TransferPanel />)
    const user = userEvent.setup()
    meta({ b2: 'last.bin', b3: 'done', b4: 'bad', b5: 'stopped' })
    useTransferStore.setState((s) => ({
      batchMeta: { ...s.batchMeta, b1: { label: 'photos', to: DL } }
    }))
    update(
      job('a', { batchId: 'b1', direction: 'download', status: 'active', totalBytes: 100 }),
      job('b', { batchId: 'b1', direction: 'download', status: 'pending' }),
      job('f', { batchId: 'b2', status: 'active', totalBytes: 50 }),
      job('g', { batchId: 'b3', status: 'pending' }),
      job('h1', { batchId: 'b4', status: 'pending' }),
      job('h2', { batchId: 'b4', status: 'pending' }),
      job('h3', { batchId: 'b4', status: 'pending' }),
      job('k', { batchId: 'b5', status: 'pending' })
    )
    update(
      job('a', {
        batchId: 'b1',
        direction: 'download',
        status: 'active',
        totalBytes: 3000,
        transferredBytes: 1000
      }),
      job('b', { batchId: 'b1', direction: 'download', status: 'completed', totalBytes: 0 }),
      job('f', { batchId: 'b2', status: 'active', totalBytes: 50, transferredBytes: 50 }),
      job('g', { batchId: 'b3', status: 'completed', transferredBytes: 100 }),
      job('h1', { batchId: 'b4', status: 'failed', error: 'denied' }),
      job('h2', { batchId: 'b4', status: 'completed', transferredBytes: 100 }),
      job('h3', { batchId: 'b4', status: 'failed', error: 'denied' }),
      job('k', { batchId: 'b5', status: 'cancelled' })
    )
    act(() =>
      useTransferStore.setState({ rates: { a: { bytes: 1000, at: 0, rate: 100, samples: 3 } } })
    )

    const photos = group('photos')
    expect(within(photos).getByText('→ This PC › C:\\dl')).toBeTruthy()
    expect(
      within(photos)
        .getByRole('progressbar', { name: 'photos progress' })
        .getAttribute('aria-valuenow')
    ).toBe('33')
    expect(within(photos).getByText('33%')).toBeTruthy()
    expect(within(photos).getByText('20 s left', { exact: false })).toBeTruthy()
    expect(within(photos).queryByRole('button')).toBeNull()

    expect(within(group('last.bin')).getByText('Finishing…')).toBeTruthy()

    const done = group('done')
    expect(done.querySelector('[data-status="completed"]')).not.toBeNull()
    expect(within(done).getByText('Completed')).toBeTruthy()
    expect(within(done).queryByRole('progressbar')).toBeNull()

    const bad = group('bad')
    expect(bad.querySelector('[data-status="failed"]')).not.toBeNull()
    await user.click(within(bad).getByRole('button', { name: 'Retry' }))
    expect(invokeCalls(mockInvoke, 'transfer:retry')).toEqual([[['h1', 'h3']]])

    expect(within(group('stopped')).getByText('Cancelled')).toBeTruthy()
    expect(within(group('stopped')).queryByRole('button')).toBeNull()
  })
})

describe('TransferPanel collapse and close', () => {
  it('collapses to the header, survives the preparing-to-job gap, closes without cancelling and reopens expanded', async () => {
    // covers: Test-1112
    render(<TransferPanel />)
    const user = userEvent.setup()
    const reply = startSend('photos')

    await user.click(listButton())
    expect(listButton().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Preparing photos…')).toBeNull()
    expect(within(region()!).getByText('Preparing 1 item')).toBeTruthy()

    // 배치 id가 오고 준비 행이 사라진 뒤, 첫 갱신이 오기 전의 틈.
    // 아무것도 그리지 않지만 접힘은 기억한다.
    await reply('b1')
    expect(region()).toBeNull()
    update(job('a', { batchId: 'b1', status: 'active' }))
    expect(region()).not.toBeNull()
    expect(listButton().getAttribute('aria-expanded')).toBe('false')
    expect(within(region()!).getByText('Uploading 1 item')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Close transfer panel' }))
    expect(region()).toBeNull()
    expect(invokeCalls(mockInvoke, 'transfer:cancel')).toEqual([])

    // 이미 살아 있는 배치의 진행은 다시 열지 않는다.
    update(job('a', { batchId: 'b1', status: 'active', transferredBytes: 50 }))
    expect(region()).toBeNull()

    const again = startSend('again')
    expect(region()).not.toBeNull()
    expect(listButton().getAttribute('aria-expanded')).toBe('true')
    expect(within(region()!).getByText('Preparing again…')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'photos' })).toBeNull()

    // 준비 중에 닫으면 그 보내기의 배치가 살아나도 다시 열지 않는다.
    await user.click(screen.getByRole('button', { name: 'Close transfer panel' }))
    await again('b2')
    update(
      job('a', { batchId: 'b1', status: 'active', transferredBytes: 60 }),
      job('b', { batchId: 'b2', status: 'active' })
    )
    expect(region()).toBeNull()
  })

  it('reopens with the row when a failed batch is retried back to pending', async () => {
    // covers: Test-1113
    render(<TransferPanel />)
    const user = userEvent.setup()
    meta({ b1: 'photos' })
    update(job('a', { batchId: 'b1', status: 'active' }))
    update(job('a', { batchId: 'b1', status: 'failed', error: 'timeout' }))
    await user.click(screen.getByRole('button', { name: 'Close transfer panel' }))
    expect(region()).toBeNull()

    update(job('a', { batchId: 'b1', status: 'pending' }))
    expect(region()).not.toBeNull()
    expect(group('photos')).toBeTruthy()
  })
})

describe('TransferPanel and clearing completed jobs', () => {
  it('drops cleared rows, hides when none remain and opens the next send expanded', async () => {
    // covers: Test-1114
    render(<TransferPanel />)
    const user = userEvent.setup()
    meta({ b1: 'ok', b2: 'bad' })
    update(job('a', { batchId: 'b1', status: 'active' }), job('b', { batchId: 'b2' }))
    update(
      job('a', { batchId: 'b1', status: 'completed', transferredBytes: 100 }),
      job('b', { batchId: 'b2', status: 'failed', error: 'x' })
    )
    expect(group('ok')).toBeTruthy()
    expect(group('bad')).toBeTruthy()

    remove('a')
    expect(screen.queryByRole('group', { name: 'ok' })).toBeNull()
    expect(group('bad')).toBeTruthy()

    // 접은 채로 모두 지워 숨으면, 다음 새 보내기는 접힘을 이어받지 않고 펼친 채로 열린다.
    await user.click(listButton())
    expect(listButton().getAttribute('aria-expanded')).toBe('false')
    remove('b')
    expect(region()).toBeNull()

    startSend('next')
    expect(listButton().getAttribute('aria-expanded')).toBe('true')
    expect(within(region()!).getByText('Preparing next…')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'bad' })).toBeNull()
  })
})
