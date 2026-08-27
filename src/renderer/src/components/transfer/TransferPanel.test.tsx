/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { makeApiMock } from '@renderer/test/rendererTestUtils'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import type { TransferJob } from '@shared/types/transfer'
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
