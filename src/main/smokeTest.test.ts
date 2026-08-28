import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PACKAGED_SMOKE_TEST_FLAG,
  isPackagedSmokeTest,
  startPackagedSmokeTest,
  type PackagedSmokeRuntime,
  type SmokeWebContents
} from './smokeTest'

interface SmokeHarness {
  webContents: SmokeWebContents
  runtime: PackagedSmokeRuntime
  emitReady: () => void
  emitLoadFailure: (isMainFrame: boolean) => void
  executeJavaScript: ReturnType<typeof vi.fn>
  exit: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
}

function createHarness(rendererMounted = true): SmokeHarness {
  let readyListener: (() => void) | undefined
  let failureListener:
    | ((
        event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean
      ) => void)
    | undefined

  const executeJavaScript = vi.fn().mockResolvedValue(rendererMounted)
  const exit = vi.fn()
  const log = vi.fn()
  const error = vi.fn()

  const webContents: SmokeWebContents = {
    once: vi.fn((event, listener) => {
      if (event === 'did-finish-load') readyListener = listener
    }),
    on: vi.fn((event, listener) => {
      if (event === 'did-fail-load') failureListener = listener
    }),
    removeListener: vi.fn(),
    executeJavaScript
  }

  return {
    webContents,
    runtime: {
      exit,
      log,
      error,
      setTimeout,
      clearTimeout
    },
    emitReady: () => readyListener?.(),
    emitLoadFailure: (isMainFrame) =>
      failureListener?.({}, -6, 'ERR_FILE_NOT_FOUND', 'file:///missing.html', isMainFrame),
    executeJavaScript,
    exit,
    log,
    error
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('packaged smoke test', () => {
  it('should activate only for a packaged app with the dedicated flag', () => {
    expect(isPackagedSmokeTest([PACKAGED_SMOKE_TEST_FLAG], true)).toBe(true)
    expect(isPackagedSmokeTest([PACKAGED_SMOKE_TEST_FLAG], false)).toBe(false)
    expect(isPackagedSmokeTest([], true)).toBe(false)
  })

  it('should exit successfully after the renderer mounts', async () => {
    const harness = createHarness(true)
    startPackagedSmokeTest(harness.webContents, harness.runtime)

    harness.emitReady()
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("document.getElementById('root')")
    )
    expect(harness.log).toHaveBeenCalledWith(expect.stringContaining('renderer ready'))
    expect(harness.exit).toHaveBeenCalledWith(0)
    expect(harness.error).not.toHaveBeenCalled()
  })

  it('should fail when the document loads without mounting the renderer', async () => {
    const harness = createHarness(false)
    startPackagedSmokeTest(harness.webContents, harness.runtime)

    harness.emitReady()
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.error).toHaveBeenCalledWith(expect.stringContaining('renderer root is empty'))
    expect(harness.exit).toHaveBeenCalledWith(1)
  })

  it('should fail on a main-frame load error and ignore subframe failures', () => {
    const harness = createHarness()
    startPackagedSmokeTest(harness.webContents, harness.runtime)

    harness.emitLoadFailure(false)
    expect(harness.exit).not.toHaveBeenCalled()

    harness.emitLoadFailure(true)
    expect(harness.error).toHaveBeenCalledWith(
      expect.stringContaining('ERR_FILE_NOT_FOUND (-6): file:///missing.html')
    )
    expect(harness.exit).toHaveBeenCalledWith(1)
  })

  it('should fail instead of hanging when renderer readiness times out', () => {
    vi.useFakeTimers()
    const harness = createHarness()
    startPackagedSmokeTest(harness.webContents, harness.runtime, 500)

    vi.advanceTimersByTime(500)

    expect(harness.error).toHaveBeenCalledWith(expect.stringContaining('timed out'))
    expect(harness.exit).toHaveBeenCalledWith(1)
  })
})
