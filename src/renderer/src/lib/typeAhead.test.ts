import { describe, it, expect } from 'vitest'
import { matchesTypeAhead, normalizeTypedChar, toInitialKeys } from './typeAhead'

describe('typeAhead', () => {
  it('spells Hangul initials as 2-beolsik keys', () => {
    expect(toInitialKeys('사진 2024.JPG')).toBe('tw 2024.jpg')
    expect(toInitialKeys('까치')).toBe('rc') // double consonant → unshifted key
  })

  it('matches Latin prefixes case-insensitively', () => {
    expect(matchesTypeAhead('README.md', 'rea')).toBe(true)
    expect(matchesTypeAhead('README.md', 'ea')).toBe(false)
  })

  it('matches Korean names by initials typed as Latin keys', () => {
    expect(matchesTypeAhead('사진첩', 'twc')).toBe(true)
    expect(matchesTypeAhead('사진첩', 'tc')).toBe(false)
  })

  it('accepts jamo when the IME delivers them', () => {
    const q = ['ㅅ', 'ㅈ'].map(normalizeTypedChar).join('')
    expect(matchesTypeAhead('사진', q)).toBe(true)
  })

  it('matches full syllables directly', () => {
    expect(matchesTypeAhead('사진', '사')).toBe(true)
  })
})
