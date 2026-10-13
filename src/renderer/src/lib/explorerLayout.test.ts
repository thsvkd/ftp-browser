import { describe, expect, it } from 'vitest'
import { optId } from './explorerLayout'

describe('optId', () => {
  it('keeps the unscoped id and prefixes an optional tab scope', () => {
    // covers: Test-1127
    expect(optId('/a b')).toBe('opt-_1b_a_w_b')
    expect(optId('/a b', 'tab3')).toBe('opt-tab3-_1b_a_w_b')

    const ids = [optId('/x', 'tab1'), optId('/x', 'tab2'), optId('/x')]
    expect(new Set(ids).size).toBe(3)

    const samples = ['/a b', 'C:\\Users\\me\\사진 2024.jpg', '/x-y/z_w', '/', '']
    for (const path of samples)
      for (const scope of [undefined, 'tab1', 'tab42'])
        expect(optId(path, scope)).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})
