import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

import { ipcMain } from 'electron'
import { registerMcpHandlers } from './mcpHandlers'
import type { McpService } from '../mcp/McpService'

type Handler = (event: unknown, ...args: unknown[]) => unknown

describe('registerMcpHandlers', () => {
  let handlers: Map<string, Handler>

  beforeEach(() => {
    vi.clearAllMocks()
    handlers = new Map()
    vi.mocked(ipcMain.handle).mockImplementation(((channel: string, listener: Handler) => {
      handlers.set(channel, listener)
    }) as unknown as typeof ipcMain.handle)
  })

  it('returns failures as IpcResult values instead of rejecting the invoke', async () => {
    // covers: Test-293
    const service = {
      getState: vi.fn(() => {
        throw new Error('SQLITE_BUSY: database is locked')
      }),
      setEnabled: vi.fn(async () => {
        throw new Error('SQLITE_BUSY: database is locked')
      }),
      regenerateToken: vi.fn(() => {
        throw new Error('SQLITE_BUSY: database is locked')
      })
    } as unknown as McpService

    registerMcpHandlers(service)

    expect([...handlers.keys()].sort()).toEqual([
      'mcp:getState',
      'mcp:regenerateToken',
      'mcp:setEnabled'
    ])
    for (const [channel, args] of [
      ['mcp:getState', []],
      ['mcp:setEnabled', [true]],
      ['mcp:regenerateToken', []]
    ] as const) {
      await expect(
        Promise.resolve().then(() => handlers.get(channel)?.(null, ...args)),
        channel
      ).resolves.toEqual({
        success: false,
        error: 'SQLITE_BUSY: database is locked',
        code: 'UNKNOWN'
      })
    }
  })
})
