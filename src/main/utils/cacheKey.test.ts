import { describe, it, expect } from 'vitest'
import { generateCacheKey } from './cacheKey'
import { THUMBNAIL_SIZE } from '@shared/constants'
import { CACHE_KEY_CASES } from '@shared/__fixtures__/cacheKeyCases'

describe('generateCacheKey', () => {
  it('should generate a key from the connection, path, size, modifiedAt, and thumbnail size', () => {
    const key = generateCacheKey('me@ftp.example.com:21', '/images/photo.jpg', 1024, '2024-01-01')
    expect(key).toBe(`me@ftp.example.com:21:/images/photo.jpg:1024:2024-01-01:${THUMBNAIL_SIZE}`)
  })

  it('should produce different keys for different hosts', () => {
    const key1 = generateCacheKey('u@host1.com:21', '/a.jpg', 100, '2024-01-01')
    const key2 = generateCacheKey('u@host2.com:21', '/a.jpg', 100, '2024-01-01')
    expect(key1).not.toBe(key2)
  })

  it('should produce different keys for different ports', () => {
    const key1 = generateCacheKey('u@host.com:21', '/a.jpg', 100, '2024-01-01')
    const key2 = generateCacheKey('u@host.com:2121', '/a.jpg', 100, '2024-01-01')
    expect(key1).not.toBe(key2)
  })

  it('should produce different keys for different users of the same host and port', () => {
    // covers: Test-999
    const key1 = generateCacheKey('u1@host.com:21', '/a.jpg', 100, '2024-01-01')
    const key2 = generateCacheKey('u2@host.com:21', '/a.jpg', 100, '2024-01-01')
    expect(key1).not.toBe(key2)
    // 렌더러 generateCacheKeyRenderer와 같은 표로 같은 문자열(src/renderer/src/lib/cacheKey.test.ts)
    for (const c of CACHE_KEY_CASES) {
      expect(generateCacheKey(c.conn, c.remotePath, c.size, c.modifiedAt)).toBe(c.key)
    }
  })

  it('should produce different keys for different file sizes', () => {
    const key1 = generateCacheKey('u@host.com:21', '/a.jpg', 100, '2024-01-01')
    const key2 = generateCacheKey('u@host.com:21', '/a.jpg', 200, '2024-01-01')
    expect(key1).not.toBe(key2)
  })

  it('should produce different keys for different modification times', () => {
    const key1 = generateCacheKey('u@host.com:21', '/a.jpg', 100, '2024-01-01')
    const key2 = generateCacheKey('u@host.com:21', '/a.jpg', 100, '2024-06-15')
    expect(key1).not.toBe(key2)
  })

  it('should handle special characters in path', () => {
    const key = generateCacheKey(
      'u@host.com:21',
      '/path with spaces/한글파일.jpg',
      100,
      '2024-01-01'
    )
    expect(key).toBe(
      `u@host.com:21:/path with spaces/한글파일.jpg:100:2024-01-01:${THUMBNAIL_SIZE}`
    )
  })

  it('should handle zero file size', () => {
    const key = generateCacheKey('u@host.com:21', '/empty.jpg', 0, '2024-01-01')
    expect(key).toContain(':0:')
  })
})
