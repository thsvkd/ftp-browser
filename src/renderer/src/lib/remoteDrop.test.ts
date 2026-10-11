import { describe, it, expect } from 'vitest'
import { joinRemotePath, planRemoteMoves } from './remoteDrop'

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
