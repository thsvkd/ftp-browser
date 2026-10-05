import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '' },
  BrowserWindow: class {}
}))

import { registerFtpHandlers } from './ftpHandlers'
import { registerOperationHandlers } from './operationHandlers'
import { registerTransferHandlers } from './transferHandlers'
import type { BrowserWindow } from 'electron'

describe('event bridges after the window is closed', () => {
  it('drops ftp, transfer and operation events instead of sending to a destroyed window', () => {
    // covers: Test-634
    let destroyed = false
    const send = vi.fn((channel: string) => {
      // Electron이 파괴된 창의 webContents에 send하면 던지는 것과 같다
      if (destroyed) throw new TypeError(`Object has been destroyed (${channel})`)
    })
    const win = { isDestroyed: () => destroyed, webContents: { send } } as unknown as BrowserWindow
    const operations = registerOperationHandlers(win)
    const { manager, fileOps } = registerFtpHandlers(win, operations)
    const queue = registerTransferHandlers(win, fileOps, manager)
    const emitAll = (): void => {
      manager.emit('connectionStatus', { status: 'connected', host: 'h' })
      queue.emit('queue:updated', { upserts: [], removedIds: [] })
      operations.emit('operation:updated', [])
      operations.emit('operation:progress', { id: 'op', completed: 1, total: 2 })
    }

    emitAll()
    expect(send.mock.calls.map(([channel]) => channel)).toEqual([
      'ftp:connectionStatus',
      'transfer:updated',
      'operation:updated',
      'operation:progress'
    ])

    // macOS는 창을 닫아도 앱이 남아, 에이전트 도구가 같은 서비스로 이벤트를 계속 낸다
    destroyed = true
    send.mockClear()
    expect(emitAll).not.toThrow()
    expect(send).not.toHaveBeenCalled()
  })
})
