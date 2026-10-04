/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { makeApiMock } from '@renderer/test/rendererTestUtils'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import type { TransferJob, TransferUpdate } from '@shared/types/transfer'
import { TransferPanel } from './TransferPanel'

const mockInvoke = vi.fn()

function job(overrides: Partial<TransferJob> & Pick<TransferJob, 'id' | 'fileName'>): TransferJob {
  return {
    direction: 'upload',
    localPath: `/local/${overrides.fileName}`,
    remotePath: `/remote/${overrides.fileName}`,
    totalBytes: 100,
    transferredBytes: 0,
    status: 'pending',
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockResolvedValue({ success: true })
  vi.stubGlobal('api', makeApiMock(mockInvoke))
  useTransferStore.setState({ jobs: [] })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TransferPanel batch progress', () => {
  it('shows one overall bar and one current-file bar for a multi-file batch', async () => {
    const batchId = 'batch-1'
    useTransferStore.setState({
      jobs: [
        job({
          id: 'completed',
          batchId,
          fileName: 'a.jpg',
          status: 'completed',
          transferredBytes: 100
        }),
        job({
          id: 'active',
          batchId,
          fileName: 'b.jpg',
          status: 'active',
          totalBytes: 200,
          transferredBytes: 50
        }),
        job({ id: 'pending', batchId, fileName: 'c.jpg', status: 'pending' })
      ]
    })

    render(<TransferPanel />)
    await userEvent.setup().click(screen.getByText(/Transfers/))

    const overall = screen.getByRole('progressbar', { name: 'Overall transfer progress' })
    const current = screen.getByRole('progressbar', { name: 'b.jpg progress' })
    expect(overall.getAttribute('aria-valuenow')).toBe('38')
    expect(current.getAttribute('aria-valuenow')).toBe('25')
    expect(screen.getAllByRole('progressbar')).toHaveLength(2)
    expect(screen.queryByText('a.jpg')).toBeNull()
    expect(screen.queryByText('c.jpg')).toBeNull()
  })

  it('keeps the second row while a live batch has no active file', async () => {
    // 파일 사이 간격, 재시도 대기, 앞 배치를 기다리는 배치 모두 active job이 없다.
    useTransferStore.setState({
      jobs: [
        job({ id: 'done', batchId: 'b', fileName: 'a.jpg', status: 'completed' }),
        job({ id: 'next', batchId: 'b', fileName: 'b.jpg', status: 'pending' })
      ]
    })

    render(<TransferPanel />)
    await userEvent.setup().click(screen.getByText(/Transfers/))

    expect(screen.getByText('b.jpg')).toBeTruthy()
  })

  it('keeps a single-file transfer as one progress row', async () => {
    useTransferStore.setState({
      jobs: [job({ id: 'single', fileName: 'only.jpg', status: 'active', transferredBytes: 40 })]
    })

    render(<TransferPanel />)
    await userEvent.setup().click(screen.getByText(/Transfers/))

    expect(
      screen.getByRole('progressbar', { name: 'only.jpg progress' }).getAttribute('aria-valuenow')
    ).toBe('40')
    expect(screen.getAllByRole('progressbar')).toHaveLength(1)
  })

  it('shows at most 99% for a file whose bytes are all sent but that is not completed yet', async () => {
    // covers: Test-302
    useTransferStore.setState({
      jobs: [job({ id: 'single', fileName: 'only.jpg', status: 'active', transferredBytes: 100 })]
    })

    render(<TransferPanel />)
    await userEvent.setup().click(screen.getByText(/Transfers/))

    expect(
      screen.getByRole('progressbar', { name: 'only.jpg progress' }).getAttribute('aria-valuenow')
    ).toBe('99')
    expect(screen.getByText('99%')).toBeTruthy()
  })

  it('shows at most 99% for a live batch that rounds up to 100%', async () => {
    // covers: Test-303
    useTransferStore.setState({
      jobs: [
        job({
          id: 'done',
          batchId: 'b',
          fileName: 'a.jpg',
          status: 'completed',
          totalBytes: 996,
          transferredBytes: 996
        }),
        job({
          id: 'last',
          batchId: 'b',
          fileName: 'b.jpg',
          status: 'active',
          totalBytes: 4,
          transferredBytes: 2
        })
      ]
    })

    render(<TransferPanel />)
    await userEvent.setup().click(screen.getByText(/Transfers/))

    expect(
      screen
        .getByRole('progressbar', { name: 'Overall transfer progress' })
        .getAttribute('aria-valuenow')
    ).toBe('99')
  })
})

describe('TransferPanel finishing state', () => {
  /** 배치 첫 줄(전체 진행률 줄) */
  async function renderBatchHeader(): Promise<HTMLElement> {
    render(<TransferPanel />)
    await userEvent.setup().click(screen.getByText(/Transfers/))
    return screen.getByText(/^Overall/).parentElement as HTMLElement
  }

  it('shows Finishing on a batch whose remaining files have all their bytes sent', async () => {
    // covers: Test-304
    useTransferStore.setState({
      jobs: [
        job({ id: 'done', batchId: 'b', fileName: 'a.jpg', status: 'completed' }),
        job({
          id: 'sent',
          batchId: 'b',
          fileName: 'b.jpg',
          status: 'active',
          transferredBytes: 100
        })
      ]
    })

    const header = await renderBatchHeader()

    expect(within(header).getByText('Finishing…')).toBeTruthy()
    expect(within(header).queryByText('In progress')).toBeNull()
  })

  it('keeps In progress on a batch that still has a queued file', async () => {
    // covers: Test-305
    useTransferStore.setState({
      jobs: [
        job({
          id: 'sent',
          batchId: 'b',
          fileName: 'a.jpg',
          status: 'active',
          transferredBytes: 100
        }),
        job({ id: 'next', batchId: 'b', fileName: 'b.jpg', status: 'pending' })
      ]
    })

    const header = await renderBatchHeader()

    expect(within(header).getByText('In progress')).toBeTruthy()
    expect(within(header).queryByText('Finishing…')).toBeNull()
  })

  it('keeps In progress on a batch with an active file that still has bytes to send', async () => {
    // covers: Test-306
    useTransferStore.setState({
      jobs: [
        job({
          id: 'sent',
          batchId: 'b',
          fileName: 'a.jpg',
          status: 'active',
          transferredBytes: 100
        }),
        job({
          id: 'sending',
          batchId: 'b',
          fileName: 'b.jpg',
          status: 'active',
          transferredBytes: 40
        })
      ]
    })

    const header = await renderBatchHeader()

    expect(within(header).getByText('In progress')).toBeTruthy()
    expect(within(header).queryByText('Finishing…')).toBeNull()
  })

  it('shows Finishing on a single file only once all of its bytes are sent', async () => {
    // covers: Test-307
    useTransferStore.setState({
      jobs: [job({ id: 'single', fileName: 'only.jpg', status: 'active', transferredBytes: 100 })]
    })
    render(<TransferPanel />)
    await userEvent.setup().click(screen.getByText(/Transfers/))

    expect(screen.getByText('Finishing…')).toBeTruthy()
    expect(screen.queryByText('In progress')).toBeNull()

    act(() =>
      useTransferStore.setState({
        jobs: [job({ id: 'single', fileName: 'only.jpg', status: 'active', transferredBytes: 99 })]
      })
    )

    expect(screen.getByText('In progress')).toBeTruthy()
    expect(screen.queryByText('Finishing…')).toBeNull()
  })

  it('shows Completed, not Finishing, on a completed file row and a completed batch row', async () => {
    // covers: Test-308
    useTransferStore.setState({
      jobs: [
        job({ id: 'single', fileName: 'single.jpg', status: 'completed', transferredBytes: 100 }),
        job({
          id: 'a',
          batchId: 'b',
          fileName: 'a.jpg',
          status: 'completed',
          transferredBytes: 100
        }),
        job({
          id: 'c',
          batchId: 'b',
          fileName: 'c.jpg',
          status: 'completed',
          transferredBytes: 100
        })
      ]
    })

    const header = await renderBatchHeader()
    const fileRow = screen.getByText('single.jpg').parentElement as HTMLElement

    expect(within(header).getByText('Completed')).toBeTruthy()
    expect(within(fileRow).getByText('Completed')).toBeTruthy()
    expect(screen.queryByText('Finishing…')).toBeNull()
  })
})

describe('TransferPanel update stream', () => {
  function captureUpdateListener(): (update: TransferUpdate) => void {
    const api = makeApiMock(mockInvoke)
    let listener: ((...args: unknown[]) => void) | undefined
    api.on.mockImplementation((channel: string, cb: (...args: unknown[]) => void) => {
      if (channel === 'transfer:updated') listener = cb
      return () => undefined
    })
    vi.stubGlobal('api', api)
    return (update) => {
      act(() => listener?.(update))
    }
  }

  it('auto-expands when a delta introduces an active job', () => {
    const push = captureUpdateListener()
    render(<TransferPanel />)
    expect(screen.queryByText('only.jpg')).toBeNull()

    push({
      upserts: [job({ id: 'single', fileName: 'only.jpg', status: 'active' })],
      removedIds: []
    })

    expect(screen.getByText('only.jpg')).toBeTruthy()
  })

  it('merges a progress-only delta into the existing job', async () => {
    const push = captureUpdateListener()
    render(<TransferPanel />)
    push({
      upserts: [job({ id: 'single', fileName: 'only.jpg', status: 'active' })],
      removedIds: []
    })

    push({
      upserts: [
        job({ id: 'single', fileName: 'only.jpg', status: 'active', transferredBytes: 60 })
      ],
      removedIds: []
    })

    expect(
      screen.getByRole('progressbar', { name: 'only.jpg progress' }).getAttribute('aria-valuenow')
    ).toBe('60')
  })

  it('does not re-expand while the run is still going after the user collapsed it', async () => {
    const push = captureUpdateListener()
    render(<TransferPanel />)
    push({ upserts: [job({ id: 'j', fileName: 'only.jpg', status: 'active' })], removedIds: [] })
    await userEvent.setup().click(screen.getByText(/Transfers/))
    expect(screen.queryByText('only.jpg')).toBeNull()

    push({
      upserts: [job({ id: 'j', fileName: 'only.jpg', status: 'active', transferredBytes: 10 })],
      removedIds: []
    })

    expect(screen.queryByText('only.jpg')).toBeNull()
  })

  it('shows jobs that already exist in the main process on mount', async () => {
    mockInvoke.mockImplementation(async (channel: string) =>
      channel === 'transfer:getAll'
        ? {
            success: true,
            data: [
              job({ id: 'old', fileName: 'old.jpg', status: 'completed', transferredBytes: 100 })
            ]
          }
        : { success: true }
    )
    render(<TransferPanel />)
    await userEvent.setup().click(screen.getByText(/Transfers/))

    expect(await screen.findByText('old.jpg')).toBeTruthy()
  })
})
