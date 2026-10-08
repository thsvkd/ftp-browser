import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// preload/index.ts는 electron과 @electron-toolkit/preload를 import한다.
// node에서 로드되도록 둘 다 목한다(devtools.test.ts와 같은 방식).
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: vi.fn(() => '') }
}))
vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))

import { contextBridge, ipcRenderer } from 'electron'

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

  it('should allow only the declared update commands and state event', async () => {
    // covers: Test-208
    const api = await loadExposedApi()
    const invoke = api.invoke as (channel: string) => Promise<unknown>
    const on = api.on as (channel: string, callback: (...args: unknown[]) => void) => () => void

    // 네 개를 모두 확인해야 화이트리스트가 실제로 선언한 만큼 열려 있는지 반증할 수 있다.
    for (const channel of [
      'update:getState',
      'update:check',
      'update:download',
      'update:setAutoUpdate',
      'update:install'
    ]) {
      await invoke(channel)
      expect(ipcRenderer.invoke).toHaveBeenCalledWith(channel)
    }

    const callback = vi.fn()
    const unsubscribe = on('update:stateChanged', callback)
    const listener = vi.mocked(ipcRenderer.on).mock.calls.at(-1)?.[1]
    expect(ipcRenderer.on).toHaveBeenCalledWith('update:stateChanged', expect.any(Function))

    listener?.({} as Electron.IpcRendererEvent, { status: 'idle' })
    expect(callback).toHaveBeenCalledWith({ status: 'idle' })

    unsubscribe()
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('update:stateChanged', listener)
    await expect(invoke('update:notAllowed')).rejects.toThrow('IPC channel not allowed')
  })

  it('should deliver transfer deltas on transfer:updated only', async () => {
    const api = await loadExposedApi()
    const on = api.on as (channel: string, callback: (...args: unknown[]) => void) => () => void

    const callback = vi.fn()
    on('transfer:updated', callback)
    const listener = vi.mocked(ipcRenderer.on).mock.calls.at(-1)?.[1]
    expect(ipcRenderer.on).toHaveBeenCalledWith('transfer:updated', expect.any(Function))

    const update = { upserts: [], removedIds: ['a'] }
    listener?.({} as Electron.IpcRendererEvent, update)
    expect(callback).toHaveBeenCalledWith(update)

    // 진행률은 upsert에 실려 오므로 별도 채널은 더 이상 열려 있지 않다.
    expect(() => on('transfer:progress', vi.fn())).toThrow('IPC event channel not allowed')
  })

  it('should allow the agent access channels', async () => {
    // covers: Test-513
    // 렌더러 테스트는 window.api를 목으로 바꾸므로 허용 목록 누락은 여기서만 잡힌다.
    const api = await loadExposedApi()
    const invoke = api.invoke as (channel: string, ...args: unknown[]) => Promise<unknown>
    const on = api.on as (channel: string, callback: (...args: unknown[]) => void) => () => void

    for (const channel of ['mcp:getState', 'mcp:setEnabled', 'mcp:regenerateToken']) {
      await invoke(channel, 'arg')
      expect(ipcRenderer.invoke).toHaveBeenCalledWith(channel, 'arg')
    }

    for (const channel of ['ftp:remoteChanged', 'agent:session']) {
      const callback = vi.fn()
      on(channel, callback)
      const listener = vi.mocked(ipcRenderer.on).mock.calls.at(-1)?.[1]
      expect(ipcRenderer.on).toHaveBeenLastCalledWith(channel, expect.any(Function))
      listener?.({} as Electron.IpcRendererEvent, { channel })
      expect(callback).toHaveBeenCalledWith({ channel })
    }
  })

  it('should allow asking how saved passwords are protected', async () => {
    // covers: Test-728
    // 렌더러 테스트는 window.api를 목으로 바꾸므로 허용 목록 누락은 여기서만 잡힌다.
    const api = await loadExposedApi()
    const invoke = api.invoke as (channel: string, ...args: unknown[]) => Promise<unknown>

    await invoke('ftp:getPasswordProtection')

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('ftp:getPasswordProtection')
  })

  it('should allow saving a server without connecting', async () => {
    const api = await loadExposedApi()
    const invoke = api.invoke as (channel: string, ...args: unknown[]) => Promise<unknown>
    const server = { name: 'NAS', host: 'nas.local', port: 21 }

    await invoke('ftp:saveServer', server)

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('ftp:saveServer', server)
  })
})
