/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
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
