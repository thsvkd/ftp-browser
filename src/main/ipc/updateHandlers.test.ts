import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

import { ipcMain } from 'electron'
import { registerUpdateHandlers } from './updateHandlers'
import type { UpdateManager } from '../update/UpdateManager'

type Handler = (event: unknown, ...args: unknown[]) => unknown

describe('registerUpdateHandlers', () => {
  let handlers: Map<string, Handler>

  beforeEach(() => {
    vi.clearAllMocks()
    handlers = new Map()
    vi.mocked(ipcMain.handle).mockImplementation(((channel: string, listener: Handler) => {
      handlers.set(channel, listener)
    }) as unknown as typeof ipcMain.handle)
  })

  it('registers the update commands and wraps their states in successful IPC results', async () => {
    // covers: Test-203
    const state = { status: 'idle', currentVersion: '1.0.5' } as const
    const manager = {
      getState: vi.fn(() => state),
      check: vi.fn(async () => state),
      download: vi.fn(async () => state),
      install: vi.fn(),
      setAutoUpdate: vi.fn(async () => state)
    } as unknown as UpdateManager
    const persistAutoUpdate = vi.fn()

    registerUpdateHandlers(manager, persistAutoUpdate)

    expect([...handlers.keys()].sort()).toEqual([
      'update:check',
      'update:download',
      'update:getState',
      'update:install',
      'update:setAutoUpdate'
    ])
    await expect(handlers.get('update:getState')?.(null)).resolves.toEqual({
      success: true,
      data: state
    })
    await expect(handlers.get('update:check')?.(null)).resolves.toEqual({
      success: true,
      data: state
    })
    await expect(handlers.get('update:download')?.(null)).resolves.toEqual({
      success: true,
      data: state
    })
    await expect(handlers.get('update:install')?.(null)).resolves.toEqual({
      success: true,
      data: undefined
    })
    await expect(handlers.get('update:setAutoUpdate')?.(null, false)).resolves.toEqual({
      success: true,
      data: state
    })
    // 저장하지 않으면 재시작 때 다시 켜진다.
    expect(persistAutoUpdate).toHaveBeenCalledWith(false)
    expect(manager.setAutoUpdate).toHaveBeenCalledWith(false)
    // 반환값만 보면 핸들러가 manager를 아예 부르지 않아도 통과한다.
    expect(manager.install).toHaveBeenCalledTimes(1)
  })
})
