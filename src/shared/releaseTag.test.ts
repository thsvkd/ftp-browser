import { describe, it, expect } from 'vitest'
import { releaseTagMatchesVersion } from './releaseTag'

describe('releaseTagMatchesVersion', () => {
  it('should accept a v-prefixed tag that matches the version exactly', () => {
    // covers: Test-168
    expect(releaseTagMatchesVersion('v1.2.3', '1.2.3')).toBe(true)
  })

  it('should reject a v-prefixed tag whose version differs', () => {
    // covers: Test-169
    expect(releaseTagMatchesVersion('v1.2.3', '1.2.4')).toBe(false)
  })

  it('should reject a tag that is missing the v prefix', () => {
    // covers: Test-170
    expect(releaseTagMatchesVersion('1.2.3', '1.2.3')).toBe(false)
  })

  it('should reject a v-prefixed tag with a prerelease suffix', () => {
    // covers: Test-171
    expect(releaseTagMatchesVersion('v1.2.3-beta.1', '1.2.3')).toBe(false)
  })
})
