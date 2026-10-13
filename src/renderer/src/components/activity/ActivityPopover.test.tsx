/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useOperationStore } from '@renderer/stores/useOperationStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { formatBytes } from '@renderer/lib/utils'
import type { OperationJob } from '@shared/types/operation'
import type { TransferJob, TransferSendResult } from '@shared/types/transfer'
import { ActivityPopover } from './ActivityPopover'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

const mockInvoke = vi.fn()
const onClose = vi.fn()

function job(id: string, overrides: Partial<TransferJob> = {}): TransferJob {
  return {
    id,
    server: 'me@nas.local:21',
    direction: 'download',
    localPath: `C:\\dl\\${id}`,
    remotePath: `/photos/${id}`,
    fileName: id,
    totalBytes: 100,
    transferredBytes: 0,
    status: 'pending',
    ...overrides
  }
}

function op(overrides: Partial<OperationJob> & Pick<OperationJob, 'id'>): OperationJob {
  return {
    kind: 'delete',
    itemCount: 1,
    unit: 'files',
    total: 1,
    completed: 0,
    status: 'active',
    ...overrides
  }
}

const DL = { side: 'local' as const, path: 'C:\\dl' }

function renderPopover(): void {
  render(<ActivityPopover anchor={null} onClose={onClose} />)
}

const group = (name: string): HTMLElement => screen.getByRole('group', { name })

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockResolvedValue({ success: true })
  vi.stubGlobal('api', makeApiMock(mockInvoke))
  useTransferStore.setState({
    jobs: [],
    rates: {},
    pendingSends: [],
    batchMeta: {},
    conflictQueue: []
  })
  useOperationStore.setState({ jobs: [] })
  useTabsStore.setState({ tabs: [], activeId: '', recent: [] })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ActivityPopover transfers', () => {
  it('groups by batch with label, progress, speed and time left; cancels, retries and clears', async () => {
    // covers: Test-816
    useTransferStore.setState({
      batchMeta: { b1: { label: 'photos', to: DL } },
      jobs: [
        job('a.jpg', { batchId: 'b1', status: 'completed', transferredBytes: 100 }),
        job('b.jpg', { batchId: 'b1', status: 'active', totalBytes: 3000, transferredBytes: 1000 }),
        job('c.jpg', { batchId: 'b1', status: 'failed', error: 'Permission denied' }),
        job('d.jpg', { batchId: 'b2', status: 'failed', error: 'Connection timed out' })
      ],
      rates: { 'b.jpg': { bytes: 1000, at: 0, rate: 100, samples: 3 } }
    })
    renderPopover()
    const user = userEvent.setup()

    const photos = group('photos')
    expect(within(photos).getByRole('progressbar', { name: 'photos progress' })).toBeTruthy()
    expect(within(photos).getByText(`${formatBytes(100)}/s`, { exact: false })).toBeTruthy()
    expect(within(photos).getByText('20 s left', { exact: false })).toBeTruthy()

    await user.click(within(photos).getByRole('button', { name: 'Cancel transfer batch' }))
    expect(invokeCalls(mockInvoke, 'transfer:cancel')).toEqual([['b.jpg']])

    // 실패가 있는 묶음은 파일 목록을 펼친 채로 연다.
    expect(
      within(photos).getByRole('button', { name: 'Files' }).getAttribute('aria-expanded')
    ).toBe('true')
    await user.click(within(photos).getByRole('button', { name: 'Cancel b.jpg' }))
    expect(invokeCalls(mockInvoke, 'transfer:cancel')).toEqual([['b.jpg'], ['b.jpg']])
    expect(within(photos).getByText('Permission denied')).toBeTruthy()
    await user.click(within(photos).getByRole('button', { name: 'Retry c.jpg' }))
    expect(invokeCalls(mockInvoke, 'transfer:retry')).toEqual([[['c.jpg']]])

    const single = group('d.jpg')
    expect(within(single).getByText('Connection timed out')).toBeTruthy()
    await user.click(within(single).getByRole('button', { name: 'Retry' }))
    expect(invokeCalls(mockInvoke, 'transfer:retry').at(-1)).toEqual([['d.jpg']])

    await user.click(screen.getByRole('button', { name: 'Retry 2 failed' }))
    expect(invokeCalls(mockInvoke, 'transfer:retry').at(-1)).toEqual([['c.jpg', 'd.jpg']])

    await user.click(screen.getByRole('button', { name: 'Clear completed' }))
    expect(invokeCalls(mockInvoke, 'transfer:clearCompleted')).toHaveLength(1)
  })

  it('shows a relay batch with the server-to-server icon, receiving bytes, prefixed errors and retry', async () => {
    // covers: Test-1027
    const A = 'me@a.example:21'
    const B = 'you@b.example:2121'
    const relay = (id: string, overrides: Partial<TransferJob>): TransferJob =>
      job(id, {
        batchId: 'r',
        direction: 'relay',
        server: B,
        sourceServer: A,
        sourcePath: `/photos/${id}`,
        localPath: '',
        remotePath: `/in/${id}`,
        totalBytes: 4000,
        ...overrides
      })
    useTransferStore.setState({
      batchMeta: { r: { label: 'photos', to: { side: 'remote', path: '/in', server: B } } },
      jobs: [
        relay('a.jpg', { status: 'active', transferredBytes: 1000 }),
        relay('b.jpg', { status: 'failed', error: `${A}: Connection timed out.` })
      ]
    })
    renderPopover()

    const photos = group('photos')
    expect(within(photos).getByRole('img', { name: 'Copy between servers' })).toBeTruthy()
    expect(photos.querySelector('.lucide-arrow-left-right')).toBeTruthy()
    expect(
      within(photos).getByText(`${formatBytes(1000)} / ${formatBytes(8000)}`, { exact: false })
    ).toBeTruthy()
    expect(within(photos).getByText(`${A}: Connection timed out.`)).toBeTruthy()
    await userEvent.setup().click(within(photos).getByRole('button', { name: 'Retry b.jpg' }))
    expect(invokeCalls(mockInvoke, 'transfer:retry')).toEqual([[['b.jpg']]])
  })

  it('shows Show in tab on a finished batch that reuses or opens the destination tab and selects the item', async () => {
    // covers: Test-818
    useTransferStore.setState({
      batchMeta: { b1: { label: 'photos', to: DL } },
      jobs: [
        job('a.jpg', {
          batchId: 'b1',
          localPath: 'C:\\dl\\photos\\a.jpg',
          status: 'completed',
          transferredBytes: 100
        })
      ]
    })
    const tabs = useTabsStore.getState()
    const dlTab = tabs.openTab(DL, false)
    tabs.openTab({ side: 'local', path: 'C:\\other' })
    renderPopover()
    const user = userEvent.setup()

    await user.click(within(group('photos')).getByRole('button', { name: 'Show in tab' }))

    let state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.activeId).toBe(dlTab)
    expect(state.tabs.find((t) => t.id === dlTab)?.sel).toEqual(['C:\\dl\\photos'])
    expect(onClose).toHaveBeenCalled()

    // 목적지 탭이 없으면 새로 연다.
    useTabsStore.getState().closeTab(dlTab)
    await user.click(within(group('photos')).getByRole('button', { name: 'Show in tab' }))
    state = useTabsStore.getState()
    const opened = state.tabs.find((t) => t.id === state.activeId)
    expect(state.tabs).toHaveLength(2)
    expect(opened?.loc).toEqual(DL)
    expect(opened?.sel).toEqual(['C:\\dl\\photos'])
  })

  it('shows a Preparing row while transfer:send is pending, drops it when done and toasts on failure', async () => {
    // covers: Test-819
    let answer!: (result: unknown) => void
    mockInvoke.mockImplementation(
      (channel: string) =>
        new Promise((resolve) => {
          if (channel === 'transfer:send') answer = resolve
          else resolve({ success: true })
        })
    )
    renderPopover()
    const meta = { label: 'photos', to: DL }
    const request = { direction: 'download' as const, sources: ['/photos'], destDir: 'C:\\dl' }
    const queued: TransferSendResult = {
      batchId: 'b1',
      ids: ['j'],
      skipped: [],
      conflicts: [],
      totalBytes: 0
    }

    let pending!: Promise<unknown>
    act(() => {
      pending = useTransferStore.getState().send('me@nas.local:21', request, meta)
    })
    expect(screen.getByText('Preparing photos…')).toBeTruthy()
    await act(async () => {
      answer({ success: true, data: queued })
      await pending
    })
    expect(screen.queryByText('Preparing photos…')).toBeNull()

    act(() => {
      pending = useTransferStore.getState().send('me@nas.local:21', request, meta)
    })
    expect(screen.getByText('Preparing photos…')).toBeTruthy()
    await act(async () => {
      answer({ success: false, error: 'boom' })
      await pending
    })
    expect(screen.queryByText('Preparing photos…')).toBeNull()
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Couldn't start the transfer", {
      description: 'boom'
    })
  })
})

describe('ActivityPopover file operations', () => {
  it('lists operations in a File operations section with operation.cancel names; clear also clears them', async () => {
    // covers: Test-817
    useOperationStore.setState({
      jobs: [
        op({ id: 'op1', itemName: 'a.jpg', total: 3, completed: 1 }),
        op({ id: 'op2', kind: 'copy', itemCount: 2, status: 'completed', completed: 2, total: 2 })
      ]
    })
    renderPopover()
    const user = userEvent.setup()

    const section = screen.getByRole('group', { name: 'File operations' })
    expect(within(section).getByText('Copying 2 items')).toBeTruthy()
    await user.click(within(section).getByRole('button', { name: 'Cancel: Deleting "a.jpg"' }))
    expect(invokeCalls(mockInvoke, 'operation:cancel')).toEqual([['op1']])

    await user.click(screen.getByRole('button', { name: 'Clear completed' }))
    expect(invokeCalls(mockInvoke, 'operation:clearFinished')).toHaveLength(1)
    expect(invokeCalls(mockInvoke, 'transfer:clearCompleted')).toHaveLength(1)
  })
})

// 옛 전송 패널의 퍼센트·Finishing 규칙(Test-302~308)을 팝오버의 묶음 행으로 옮겼다.
describe('ActivityPopover batch progress', () => {
  function percentOf(name: string): string | null {
    return within(group(name))
      .getByRole('progressbar', { name: `${name} progress` })
      .getAttribute('aria-valuenow')
  }

  it('shows at most 99% for a file whose bytes are all sent but that is not completed yet', () => {
    // covers: Test-302
    useTransferStore.setState({
      jobs: [job('only.jpg', { status: 'active', transferredBytes: 100 })]
    })
    renderPopover()

    expect(percentOf('only.jpg')).toBe('99')
    expect(within(group('only.jpg')).getByText(/99%/)).toBeTruthy()
  })

  it('shows at most 99% for a live batch that rounds up to 100%', () => {
    // covers: Test-303
    useTransferStore.setState({
      batchMeta: { b: { label: 'batch', to: DL } },
      jobs: [
        job('a.jpg', { batchId: 'b', status: 'completed', totalBytes: 996, transferredBytes: 996 }),
        job('b.jpg', { batchId: 'b', status: 'active', totalBytes: 4, transferredBytes: 2 })
      ]
    })
    renderPopover()

    expect(percentOf('batch')).toBe('99')
  })
})

describe('ActivityPopover finishing state', () => {
  function renderBatch(jobs: TransferJob[]): HTMLElement {
    useTransferStore.setState({
      batchMeta: { b: { label: 'batch', to: DL } },
      jobs: jobs.map((j) => ({ ...j, batchId: 'b' }))
    })
    renderPopover()
    return group('batch')
  }

  it('shows Finishing on a batch whose remaining files have all their bytes sent', () => {
    // covers: Test-304
    const header = renderBatch([
      job('a.jpg', { status: 'completed' }),
      job('b.jpg', { status: 'active', transferredBytes: 100 })
    ])

    expect(within(header).getByText('Finishing…')).toBeTruthy()
    expect(within(header).queryByText('In progress')).toBeNull()
  })

  it('keeps In progress on a batch that still has a queued file', () => {
    // covers: Test-305
    const header = renderBatch([
      job('a.jpg', { status: 'active', transferredBytes: 100 }),
      job('b.jpg', { status: 'pending' })
    ])

    expect(within(header).getByText('In progress')).toBeTruthy()
    expect(within(header).queryByText('Finishing…')).toBeNull()
  })

  it('keeps In progress on a batch with an active file that still has bytes to send', () => {
    // covers: Test-306
    const header = renderBatch([
      job('a.jpg', { status: 'active', transferredBytes: 100 }),
      job('b.jpg', { status: 'active', transferredBytes: 40 })
    ])

    expect(within(header).getByText('In progress')).toBeTruthy()
    expect(within(header).queryByText('Finishing…')).toBeNull()
  })

  it('shows Finishing on a single file only once all of its bytes are sent', () => {
    // covers: Test-307
    useTransferStore.setState({
      jobs: [job('only.jpg', { status: 'active', transferredBytes: 100 })]
    })
    renderPopover()

    expect(within(group('only.jpg')).getByText('Finishing…')).toBeTruthy()
    expect(screen.queryByText('In progress')).toBeNull()

    act(() =>
      useTransferStore.setState({
        jobs: [job('only.jpg', { status: 'active', transferredBytes: 99 })]
      })
    )

    expect(within(group('only.jpg')).getByText('In progress')).toBeTruthy()
    expect(screen.queryByText('Finishing…')).toBeNull()
  })

  it('shows Completed, not Finishing, on a completed file row and a completed batch row', () => {
    // covers: Test-308
    useTransferStore.setState({
      batchMeta: { b: { label: 'batch', to: DL } },
      jobs: [
        job('single.jpg', { status: 'completed', transferredBytes: 100 }),
        job('a.jpg', { batchId: 'b', status: 'completed', transferredBytes: 100 }),
        job('c.jpg', { batchId: 'b', status: 'completed', transferredBytes: 100 })
      ]
    })
    renderPopover()

    expect(within(group('batch')).getByText('Completed')).toBeTruthy()
    expect(within(group('single.jpg')).getByText('Completed')).toBeTruthy()
    expect(screen.queryByText('Finishing…')).toBeNull()
  })
})
