/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { makeApiMock } from '@renderer/test/rendererTestUtils'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useOperationStore } from '@renderer/stores/useOperationStore'
import type { TransferJob } from '@shared/types/transfer'
import { ActivityPill } from './ActivityPill'

const mockInvoke = vi.fn()

function job(id: string, overrides: Partial<TransferJob> = {}): TransferJob {
  return {
    id,
    batchId: 'b',
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

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockResolvedValue({ success: true, data: [] })
  vi.stubGlobal('api', makeApiMock(mockInvoke))
  useTransferStore.setState({ jobs: [], rates: {}, pendingSends: [], batchMeta: {} })
  useOperationStore.setState({ jobs: [] })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ActivityPill', () => {
  it('shows a ring, a percent capped at 99 before completion and the count while running; idle otherwise; a danger dot on failures', () => {
    // covers: Test-815
    useTransferStore.setState({
      jobs: [
        job('a.jpg', { status: 'completed', transferredBytes: 100 }),
        job('b.jpg', { status: 'active', transferredBytes: 100 })
      ]
    })
    const { container, rerender } = render(<ActivityPill />)

    const pill = screen.getByRole('button', { name: 'Activity: 99%, 1 of 2' })
    expect(pill.textContent).toContain('99%')
    expect(pill.textContent).toContain('1/2')
    expect(pill.querySelector('svg circle[stroke-dasharray]')).toBeTruthy()
    expect(container.querySelector('[data-tone="danger"]')).toBeNull()

    useTransferStore.setState({ jobs: [] })
    rerender(<ActivityPill />)
    const idle = screen.getByRole('button', { name: 'Activity' })
    expect(idle.getAttribute('title')).toBe('No transfers running')
    expect(idle.textContent).not.toContain('%')
    expect(idle.querySelector('svg circle[stroke-dasharray]')).toBeNull()

    useTransferStore.setState({ jobs: [job('c.jpg', { status: 'failed', error: 'timeout' })] })
    rerender(<ActivityPill />)
    expect(container.querySelector('[data-tone="danger"]')?.textContent).toBe('1')
    // 화면 낭독기도 실패를 듣는다
    screen.getByRole('button', { name: 'Activity, Failed: 1' })
  })
})
