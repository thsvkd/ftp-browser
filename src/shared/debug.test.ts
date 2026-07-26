import { describe, it, expect } from 'vitest'
import {
  DEVTOOLS_FLAG,
  DEBUG_RENDERER_ARG,
  isDebugEnabled,
  debugRendererArgs,
  hasDebugRendererArg
} from './debug'

/** Electron argv는 항상 실행 파일 경로로 시작하므로 그 형태를 흉내낸다. */
function argv(...args: string[]): string[] {
  return ['C:\\app\\ftp-browser.exe', ...args]
}

describe('isDebugEnabled', () => {
  it('should enable debug when packaged build receives --devtools', () => {
    // covers: Test-1
    expect(isDebugEnabled(argv(DEVTOOLS_FLAG), true)).toBe(true)
  })

  it('should disable debug when packaged build has no --devtools', () => {
    // covers: Test-2
    expect(isDebugEnabled(argv(), true)).toBe(false)
    expect(isDebugEnabled(argv('--some-other-flag'), true)).toBe(false)
  })

  it('should enable debug in dev build without --devtools', () => {
    // covers: Test-3
    expect(isDebugEnabled(argv(), false)).toBe(true)
  })

  it('should not treat prefix-matching arguments as --devtools', () => {
    // covers: Test-4
    expect(isDebugEnabled(argv('--devtools-extended'), true)).toBe(false)
    expect(isDebugEnabled(argv('--devtoolsx'), true)).toBe(false)
    expect(isDebugEnabled(argv('--devtools=1'), true)).toBe(false)
    // `--debug` is the flag Electron rejects; it must not enable anything either.
    expect(isDebugEnabled(argv('--debug'), true)).toBe(false)
  })
})

describe('debugRendererArgs / hasDebugRendererArg', () => {
  it('should pass the renderer debug token when debug is enabled', () => {
    // covers: Test-28
    const args = debugRendererArgs(true)
    expect(args).toContain(DEBUG_RENDERER_ARG)
    expect(hasDebugRendererArg(argv(...args))).toBe(true)
  })

  it('should pass no renderer debug token when debug is disabled', () => {
    // covers: Test-29
    const args = debugRendererArgs(false)
    expect(args).not.toContain(DEBUG_RENDERER_ARG)
    expect(args).toHaveLength(0)
    expect(hasDebugRendererArg(argv(...args))).toBe(false)
  })
})
