import { describe, it, expect } from 'vitest'
import { shouldDeferToNativeContextMenu } from './debugTools'

describe('shouldDeferToNativeContextMenu', () => {
  it('should defer to the native menu on Shift+right-click while debugging', () => {
    // covers: Test-25
    expect(shouldDeferToNativeContextMenu({ shiftKey: true }, true)).toBe(true)
  })

  it('should keep the app menu on a plain right-click while debugging', () => {
    // covers: Test-26
    expect(shouldDeferToNativeContextMenu({ shiftKey: false }, true)).toBe(false)
  })

  it('should keep the app menu on Shift+right-click when debugging is off', () => {
    // covers: Test-27
    expect(shouldDeferToNativeContextMenu({ shiftKey: true }, false)).toBe(false)
  })
})
