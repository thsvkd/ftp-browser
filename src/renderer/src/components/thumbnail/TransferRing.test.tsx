/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import type { TransferJob } from '@shared/types/transfer'
import { TransferRing } from './TransferRing'

afterEach(() => {
  cleanup()
  useTransferStore.setState({ jobs: [] })
})

function job(id: string, patch: Partial<TransferJob>): TransferJob {
  return {
    id,
    direction: 'download',
    localPath: `C:\\dl\\${id}`,
    remotePath: `/photos/${id}`,
    fileName: id,
    totalBytes: 100,
    transferredBytes: 0,
    status: 'pending',
    ...patch
  }
}

const ring = (): HTMLElement | null => document.querySelector('[data-transfer-ring]')

describe('TransferRing', () => {
  it('shows progress for a transfer from this path and sums the jobs under a folder', () => {
    // covers: Test-831
    useTransferStore.setState({
      jobs: [
        job('a.jpg', { status: 'active', transferredBytes: 40 }),
        job('sub/b.jpg', {
          remotePath: '/photos/sub/b.jpg',
          status: 'active',
          transferredBytes: 50
        }),
        job('sub/c.jpg', { remotePath: '/photos/sub/c.jpg', status: 'pending' }),
        job('done.jpg', { status: 'completed', transferredBytes: 100 })
      ]
    })
    render(<TransferRing entry={{ side: 'remote', path: '/photos/a.jpg' }} />)
    expect(screen.getByRole('img', { name: 'In progress 40%' })).toBeTruthy()
    cleanup()

    // 폴더: 아래 작업 두 개의 합(50 + 0) / 200 = 25%
    render(<TransferRing entry={{ side: 'remote', path: '/photos/sub' }} />)
    expect(screen.getByRole('img', { name: 'In progress 25%' })).toBeTruthy()
    act(() =>
      useTransferStore.setState((s) => ({
        jobs: s.jobs.map((j) => (j.id === 'sub/c.jpg' ? { ...j, status: 'failed' } : j))
      }))
    )
    expect(ring()?.getAttribute('data-transfer-ring')).toBe('failed')
    cleanup()

    // 끝난 전송과, 출처가 아닌 쪽(로컬 다운로드 대상)에는 고리가 없다.
    render(<TransferRing entry={{ side: 'remote', path: '/photos/done.jpg' }} />)
    expect(ring()).toBeNull()
    cleanup()
    render(<TransferRing entry={{ side: 'local', path: 'C:\\dl\\a.jpg' }} />)
    expect(ring()).toBeNull()
  })
})
