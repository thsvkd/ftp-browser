import { describe, it, expect } from 'vitest'
import { generateCacheKey } from './cacheKey'

describe('generateCacheKey', () => {
  it('should generate a key from host, port, path, size, and modifiedAt', () => {
    const key = generateCacheKey('ftp.example.com', 21, '/images/photo.jpg', 1024, '2024-01-01')
    expect(key).toBe('ftp.example.com:21:/images/photo.jpg:1024:2024-01-01')
  })

  it('should produce different keys for different hosts', () => {
    const key1 = generateCacheKey('host1.com', 21, '/a.jpg', 100, '2024-01-01')
    const key2 = generateCacheKey('host2.com', 21, '/a.jpg', 100, '2024-01-01')
    expect(key1).not.toBe(key2)
  })

  it('should produce different keys for different ports', () => {
    const key1 = generateCacheKey('host.com', 21, '/a.jpg', 100, '2024-01-01')
    const key2 = generateCacheKey('host.com', 2121, '/a.jpg', 100, '2024-01-01')
    expect(key1).not.toBe(key2)
  })

  it('should produce different keys for different file sizes', () => {
    const key1 = generateCacheKey('host.com', 21, '/a.jpg', 100, '2024-01-01')
    const key2 = generateCacheKey('host.com', 21, '/a.jpg', 200, '2024-01-01')
    expect(key1).not.toBe(key2)
  })

  it('should produce different keys for different modification times', () => {
    const key1 = generateCacheKey('host.com', 21, '/a.jpg', 100, '2024-01-01')
    const key2 = generateCacheKey('host.com', 21, '/a.jpg', 100, '2024-06-15')
    expect(key1).not.toBe(key2)
  })

  it('should handle special characters in path', () => {
    const key = generateCacheKey(
      'host.com',
      21,
      '/path with spaces/한글파일.jpg',
      100,
      '2024-01-01'
    )
    expect(key).toBe('host.com:21:/path with spaces/한글파일.jpg:100:2024-01-01')
  })

  it('should handle zero file size', () => {
    const key = generateCacheKey('host.com', 21, '/empty.jpg', 0, '2024-01-01')
    expect(key).toContain(':0:')
  })
})
