import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

import { ipcMain } from 'electron'
import { registerUpdateHandlers } from './updateHandlers'
import type { UpdateManager } from '../update/UpdateManager'

type Handler = (event: unknown) => unknown

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
      install: vi.fn()
    } as unknown as UpdateManager

    registerUpdateHandlers(manager)

    expect([...handlers.keys()].sort()).toEqual([
      'update:check',
      'update:download',
      'update:getState',
      'update:install'
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
  })
})
