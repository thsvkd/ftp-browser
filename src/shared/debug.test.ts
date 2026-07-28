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

// D4로 `isPackaged` 파라미터가 사라졌다. 패키징 빌드와 dev 빌드가 같은 코드 경로를
// 타므로 Test-1/2(패키징 관점)와 Test-66/3(dev 관점)은 같은 계약을 양쪽 시점에서
// 고정한다. 케이스 리스트가 둘 다 요구하므로 그대로 둔다.
describe('isDebugEnabled', () => {
  it('should enable debug when argv contains --devtools', () => {
    // covers: Test-1
    expect(isDebugEnabled(argv(DEVTOOLS_FLAG))).toBe(true)
  })

  it('should disable debug when argv has no --devtools', () => {
    // covers: Test-2
    expect(isDebugEnabled(argv())).toBe(false)
    expect(isDebugEnabled(argv('--some-other-flag'))).toBe(false)
  })

  it('should disable debug in dev build without --devtools', () => {
    // covers: Test-3
    expect(isDebugEnabled(argv())).toBe(false)
  })

  it('should enable debug in dev build with --devtools', () => {
    // covers: Test-66
    expect(isDebugEnabled(argv(DEVTOOLS_FLAG))).toBe(true)
  })

  it('should not treat prefix-matching arguments as --devtools', () => {
    // covers: Test-4
    expect(isDebugEnabled(argv('--devtools-extended'))).toBe(false)
    expect(isDebugEnabled(argv('--devtoolsx'))).toBe(false)
    expect(isDebugEnabled(argv('--devtools=1'))).toBe(false)
    // `--debug` is the flag Electron rejects; it must not enable anything either.
    expect(isDebugEnabled(argv('--debug'))).toBe(false)
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
