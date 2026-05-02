import { describe, it, expect } from 'vitest'
import { normalizeRemotePath, getParentRemotePath } from './remotePath'

describe('normalizeRemotePath', () => {
  it('treats empty input as root', () => {
    expect(normalizeRemotePath('')).toBe('/')
  })

  it('preserves root', () => {
    expect(normalizeRemotePath('/')).toBe('/')
    expect(normalizeRemotePath('//')).toBe('/')
  })

  it('strips trailing slashes for non-root paths', () => {
    expect(normalizeRemotePath('/foo/')).toBe('/foo')
    expect(normalizeRemotePath('/foo//')).toBe('/foo')
    expect(normalizeRemotePath('/foo/bar/')).toBe('/foo/bar')
  })

  it('keeps already-canonical paths unchanged', () => {
    expect(normalizeRemotePath('/foo/bar')).toBe('/foo/bar')
  })

  it('prepends a leading slash if missing', () => {
    expect(normalizeRemotePath('foo/bar')).toBe('/foo/bar')
    expect(normalizeRemotePath('foo/bar/')).toBe('/foo/bar')
  })
})

describe('getParentRemotePath', () => {
  it('returns root for root', () => {
    expect(getParentRemotePath('/')).toBe('/')
    expect(getParentRemotePath('')).toBe('/')
  })

  it('returns root for top-level entries', () => {
    expect(getParentRemotePath('/foo')).toBe('/')
    expect(getParentRemotePath('/foo/')).toBe('/')
  })

  it('returns parent directory for nested paths', () => {
    expect(getParentRemotePath('/foo/bar')).toBe('/foo')
    expect(getParentRemotePath('/foo/bar/')).toBe('/foo')
    expect(getParentRemotePath('/foo/bar/baz.jpg')).toBe('/foo/bar')
  })

  it('produces the same parent for normalized and non-normalized inputs', () => {
    // 핵심 invariant: 캐시 invalidation이 trailing slash 차이로 누락되면 안 된다.
    expect(getParentRemotePath('/foo/bar/baz.jpg')).toBe(getParentRemotePath('/foo/bar/baz.jpg/'))
  })
})
