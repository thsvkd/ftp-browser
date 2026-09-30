import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTransferStore } from './useTransferStore'
import type { TransferJob } from '@shared/types/transfer'

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

describe('useTransferStore.enqueueBatch', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue({ success: true, data: [] })
    vi.stubGlobal('window', { api: { invoke } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const item = { localPath: '/l/a', remotePath: '/r/d/a', fileName: 'a', totalBytes: 1 }

  it('passes remoteDirs through to transfer:enqueueBatch', async () => {
    await useTransferStore.getState().enqueueBatch('upload', [item], true, ['/r/d'])

    expect(invoke).toHaveBeenCalledWith('transfer:enqueueBatch', {
      direction: 'upload',
      items: [item],
      forceBatch: true,
      remoteDirs: ['/r/d']
    })
  })

  it('leaves remoteDirs undefined when the caller has none', async () => {
    await useTransferStore.getState().enqueueBatch('download', [item])

    expect(invoke.mock.calls[0][1]).toMatchObject({ forceBatch: false, remoteDirs: undefined })
  })
})
