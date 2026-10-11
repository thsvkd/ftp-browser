import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  nativeTheme: { themeSource: 'system' }
}))

import { ipcMain, nativeTheme } from 'electron'
import { registerAppHandlers } from './appHandlers'

type Handler = (event: unknown, ...args: unknown[]) => unknown

describe('registerAppHandlers', () => {
  let handlers: Map<string, Handler>

  beforeEach(() => {
    handlers = new Map()
    vi.mocked(ipcMain.handle).mockImplementation(((channel: string, listener: Handler) => {
      handlers.set(channel, listener)
    }) as unknown as typeof ipcMain.handle)
    nativeTheme.themeSource = 'system'
    registerAppHandlers()
  })

  it('sets the native theme source to system, light or dark and refuses anything else', () => {
    // covers: Test-843
    const setTheme = handlers.get('app:setTheme')!
    for (const theme of ['dark', 'light', 'system'] as const) {
      expect(setTheme(null, theme)).toEqual({ success: true, data: undefined })
      expect(nativeTheme.themeSource).toBe(theme)
    }

    nativeTheme.themeSource = 'dark'
    for (const bad of ['blue', '', null, 1]) {
      expect(setTheme(null, bad)).toMatchObject({ success: false })
      expect(nativeTheme.themeSource).toBe('dark')
    }
  })
})
