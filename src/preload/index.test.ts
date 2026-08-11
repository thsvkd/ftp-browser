import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// preload/index.ts는 electron과 @electron-toolkit/preload를 import한다.
// node에서 로드되도록 둘 다 목한다(devtools.test.ts와 같은 방식).
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: vi.fn(() => '') }
}))
vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))

import { contextBridge } from 'electron'

/** 실제 값과 겹치지 않는 값이어야 "그대로 흘려보내는지"가 반증 가능해진다. */
const SENTINEL_PLATFORM = 'sentinel-platform'

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

/**
 * `process.platform`을 센티넬로 바꾼 뒤 preload를 새로 평가하고, 노출된 `api`를 돌려준다.
 * 값은 모듈 평가 시점에 캡처되므로 import 전에 바꿔야 하고, 다른 테스트로 새지 않도록
 * import 직후 되돌린다.
 */
async function loadExposedApi(): Promise<Record<string, unknown>> {
  // contextIsolation은 실제 앱에서 켜져 있다. node에서는 이 값이 없어 분기가 갈리므로 고정한다.
  Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
  Object.defineProperty(process, 'platform', { configurable: true, value: SENTINEL_PLATFORM })
  try {
    await import('./index')
  } finally {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
  }

  const call = vi.mocked(contextBridge.exposeInMainWorld).mock.calls.find(([key]) => key === 'api')
  if (!call) throw new Error('preload did not expose an `api` object')
  return call[1] as Record<string, unknown>
}

beforeEach(() => {
  vi.resetModules()
  vi.mocked(contextBridge.exposeInMainWorld).mockClear()
})

afterEach(() => {
  Reflect.deleteProperty(process, 'contextIsolated')
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
})

describe('preload api', () => {
  it('should expose the process platform to the renderer', async () => {
    // covers: Test-159
    const api = await loadExposedApi()

    expect(api.platform).toBe(SENTINEL_PLATFORM)
  })
})
