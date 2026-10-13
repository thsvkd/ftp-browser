import { describe, expect, it } from 'vitest'
import { CACHE_KEY_CASES } from '@shared/__fixtures__/cacheKeyCases'
import { generateCacheKeyRenderer } from './cacheKey'

describe('generateCacheKeyRenderer', () => {
  it('keys each user of a host apart and matches the main-process key on the shared table', () => {
    // covers: Test-999
    expect(generateCacheKeyRenderer('u1@host.com:21', '/a.jpg', 100, 't')).not.toBe(
      generateCacheKeyRenderer('u2@host.com:21', '/a.jpg', 100, 't')
    )
    // main generateCacheKey가 같은 표로 같은 문자열을 내는지는 src/main/utils/cacheKey.test.ts가 본다
    for (const c of CACHE_KEY_CASES) {
      expect(generateCacheKeyRenderer(c.conn, c.remotePath, c.size, c.modifiedAt)).toBe(c.key)
    }
  })
})
