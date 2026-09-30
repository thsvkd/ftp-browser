import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { joinRemotePath, planRemoteMoves, performRemoteDrop } from './remoteDrop'

describe('joinRemotePath', () => {
  it('joins a child onto the root without doubling the slash', () => {
    expect(joinRemotePath('/', 'file.txt')).toBe('/file.txt')
  })

  it('joins a child onto a nested directory', () => {
    expect(joinRemotePath('/a/b', 'file.txt')).toBe('/a/b/file.txt')
  })

  it('preserves multi-segment relative paths', () => {
    expect(joinRemotePath('/dest', 'sub/file.txt')).toBe('/dest/sub/file.txt')
    expect(joinRemotePath('/', 'sub/file.txt')).toBe('/sub/file.txt')
  })
})

describe('planRemoteMoves', () => {
  const item = (
    remotePath: string,
    fileName: string
  ): { remotePath: string; fileName: string; size: number } => ({ remotePath, fileName, size: 1 })

  it('plans a rename into the target folder', () => {
    const moves = planRemoteMoves([item('/a/file.txt', 'file.txt')], '/a/sub')
    expect(moves).toEqual([{ oldPath: '/a/file.txt', newPath: '/a/sub/file.txt' }])
  })

  it('moves into the root target', () => {
    const moves = planRemoteMoves([item('/a/file.txt', 'file.txt')], '/')
    expect(moves).toEqual([{ oldPath: '/a/file.txt', newPath: '/file.txt' }])
  })

  it('skips files already in the target directory (no-op move)', () => {
    expect(planRemoteMoves([item('/a/file.txt', 'file.txt')], '/a')).toEqual([])
  })

  it('skips files already at the root when target is root', () => {
    expect(planRemoteMoves([item('/file.txt', 'file.txt')], '/')).toEqual([])
  })

  it('keeps only the files that actually change location', () => {
    const moves = planRemoteMoves(
      [item('/a/keep.txt', 'keep.txt'), item('/dest/skip.txt', 'skip.txt')],
      '/dest'
    )
    expect(moves).toEqual([{ oldPath: '/a/keep.txt', newPath: '/dest/keep.txt' }])
  })

  it('returns an empty plan for no items', () => {
    expect(planRemoteMoves([], '/dest')).toEqual([])
  })
})

describe('performRemoteDrop (local upload)', () => {
  const invoke = vi.fn()

  /** 로컬 패널에서 끌어온 것처럼 application/x-local-files만 채운 dataTransfer */
  const localDrop = (): DataTransfer =>
    ({
      getData: (type: string) =>
        type === 'application/x-local-files' ? JSON.stringify([{ localPath: '/src/photos' }]) : '',
      files: []
    }) as unknown as DataTransfer

  const expandTo = (relativePaths: string[]): void => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'local:expandForUpload') {
        return {
          success: true,
          data: relativePaths.map((relativePath) => ({
            localPath: `/src/${relativePath}`,
            relativePath,
            size: 5
          }))
        }
      }
      return { success: true, data: [] }
    })
  }

  const enqueuePayload = (): {
    direction: string
    items: Array<{ remotePath: string }>
    forceBatch: boolean
    remoteDirs?: string[]
  } => {
    const call = invoke.mock.calls.find(([channel]) => channel === 'transfer:enqueueBatch')
    expect(call).toBeDefined()
    return call![1]
  }

  beforeEach(() => {
    invoke.mockReset()
    vi.stubGlobal('window', { api: { invoke } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('never calls ftp:mkdir and hands the missing dirs to the batch, ancestors included', async () => {
    expandTo(['photos/a/1.jpg', 'photos/a/b/2.jpg', 'photos/c/3.jpg', 'top.jpg'])

    await performRemoteDrop(localDrop(), '/t')

    expect(invoke.mock.calls.some(([channel]) => channel === 'ftp:mkdir')).toBe(false)
    const payload = enqueuePayload()
    expect(payload.direction).toBe('upload')
    expect(payload.forceBatch).toBe(true)
    expect([...payload.remoteDirs!].sort()).toEqual([
      '/t/photos',
      '/t/photos/a',
      '/t/photos/a/b',
      '/t/photos/c'
    ])
    expect(payload.items.map((item) => item.remotePath)).toContain('/t/photos/a/b/2.jpg')
  })

  it('does not list the target folder or the root as a dir to create', async () => {
    expandTo(['a.jpg', 'sub/b.jpg'])

    await performRemoteDrop(localDrop(), '/')

    expect(enqueuePayload().remoteDirs).toEqual(['/sub'])
  })

  it('sends an empty dir list when every file lands directly in the target', async () => {
    expandTo(['a.jpg', 'b.jpg'])

    await performRemoteDrop(localDrop(), '/t')

    expect(invoke.mock.calls.some(([channel]) => channel === 'ftp:mkdir')).toBe(false)
    expect(enqueuePayload().remoteDirs ?? []).toEqual([])
  })
})
