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
    server: 'me@nas.local:21',
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
    render(
      <TransferRing entry={{ side: 'remote', path: '/photos/a.jpg', server: 'me@nas.local:21' }} />
    )
    expect(screen.getByRole('img', { name: 'In progress 40%' })).toBeTruthy()
    cleanup()

    // 폴더: 아래 작업 두 개의 합(50 + 0) / 200 = 25%
    render(
      <TransferRing entry={{ side: 'remote', path: '/photos/sub', server: 'me@nas.local:21' }} />
    )
    expect(screen.getByRole('img', { name: 'In progress 25%' })).toBeTruthy()
    act(() =>
      useTransferStore.setState((s) => ({
        jobs: s.jobs.map((j) => (j.id === 'sub/c.jpg' ? { ...j, status: 'failed' } : j))
      }))
    )
    expect(ring()?.getAttribute('data-transfer-ring')).toBe('failed')
    cleanup()

    // 끝난 전송과, 출처가 아닌 쪽(로컬 다운로드 대상)에는 고리가 없다.
    render(
      <TransferRing
        entry={{ side: 'remote', path: '/photos/done.jpg', server: 'me@nas.local:21' }}
      />
    )
    expect(ring()).toBeNull()
    cleanup()
    render(<TransferRing entry={{ side: 'local', path: 'C:\\dl\\a.jpg' }} />)
    expect(ring()).toBeNull()
  })

  it("draws a remote ring only on the job's own server, and on the sending side of a relay", () => {
    // covers: Test-1038
    const A = 'me@a.example:21'
    const B = 'you@b.example:2121'
    useTransferStore.setState({
      jobs: [job('a.jpg', { server: A, remotePath: '/photos/a.jpg', status: 'active' })]
    })
    render(<TransferRing entry={{ side: 'remote', path: '/photos/a.jpg', server: B }} />)
    expect(ring()).toBeNull()
    cleanup()
    render(<TransferRing entry={{ side: 'remote', path: '/photos/a.jpg', server: A }} />)
    expect(ring()).not.toBeNull()
    cleanup()

    useTransferStore.setState({
      jobs: [
        job('r', {
          direction: 'relay',
          server: B,
          sourceServer: A,
          sourcePath: '/photos/a.jpg',
          remotePath: '/in/a.jpg',
          localPath: '',
          status: 'active'
        })
      ]
    })
    for (const path of ['/photos/a.jpg', '/photos']) {
      render(<TransferRing entry={{ side: 'remote', path, server: A }} />)
      expect(ring()).not.toBeNull()
      cleanup()
    }
    for (const path of ['/in/a.jpg', '/photos/a.jpg']) {
      render(<TransferRing entry={{ side: 'remote', path, server: B }} />)
      expect(ring()).toBeNull()
      cleanup()
    }
  })

  it('marks a remote folder that receives an upload under it', () => {
    // covers: Test-1093
    useTransferStore.setState({
      jobs: [
        job('a.bin', {
          direction: 'upload',
          localPath: '/Users/me/folder/sub/a.bin',
          remotePath: '/dest/folder/sub/a.bin',
          status: 'active',
          transferredBytes: 40
        })
      ]
    })
    render(
      <TransferRing entry={{ side: 'remote', path: '/dest/folder', server: 'me@nas.local:21' }} />
    )
    expect(ring()?.getAttribute('data-transfer-ring')).toBe('active')
    expect(ring()?.getAttribute('aria-label')).toContain('40%')
    cleanup()

    // 다른 서버의 같은 경로는 다른 폴더다
    render(
      <TransferRing
        entry={{ side: 'remote', path: '/dest/folder', server: 'you@b.example:2121' }}
      />
    )
    expect(ring()).toBeNull()
  })

  it('marks a local folder that receives a download under it, but not a sibling with the same prefix', () => {
    // covers: Test-1094
    useTransferStore.setState({
      jobs: [
        job('a.jpg', {
          localPath: 'C:\\dl\\x\\a.jpg',
          remotePath: '/photos/x/a.jpg',
          status: 'active',
          transferredBytes: 40
        })
      ]
    })
    render(<TransferRing entry={{ side: 'local', path: 'C:\\dl' }} />)
    expect(screen.getByRole('img', { name: 'In progress 40%' })).toBeTruthy()
    cleanup()

    act(() =>
      useTransferStore.setState({
        jobs: [job('a.jpg', { localPath: 'C:\\dl2\\a.jpg', status: 'active' })]
      })
    )
    render(<TransferRing entry={{ side: 'local', path: 'C:\\dl' }} />)
    expect(ring()).toBeNull()
  })

  it('shows no ring on the destination side once the jobs are done or cancelled', () => {
    // covers: Test-1095
    useTransferStore.setState({
      jobs: [
        job('a.bin', {
          direction: 'upload',
          localPath: '/Users/me/a.bin',
          remotePath: '/dest/folder/a.bin',
          status: 'completed',
          transferredBytes: 100
        }),
        job('b.bin', {
          direction: 'upload',
          localPath: '/Users/me/b.bin',
          remotePath: '/dest/folder/b.bin',
          status: 'cancelled'
        }),
        job('c.jpg', { localPath: 'C:\\dl\\x\\c.jpg', status: 'completed' })
      ]
    })
    render(
      <TransferRing entry={{ side: 'remote', path: '/dest/folder', server: 'me@nas.local:21' }} />
    )
    expect(ring()).toBeNull()
    cleanup()
    render(<TransferRing entry={{ side: 'local', path: 'C:\\dl' }} />)
    expect(ring()).toBeNull()
  })
})
