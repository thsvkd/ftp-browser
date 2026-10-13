import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '' },
  BrowserWindow: class {}
}))

import { registerFtpHandlers } from './ftpHandlers'
import { registerOperationHandlers } from './operationHandlers'
import { registerTransferHandlers } from './transferHandlers'
import { ConnectionRegistry } from '../ftp/ConnectionRegistry'
import { fakeSession, payloadOf, remoteOf } from '../ftp/__fixtures__/fakeSessions'
import { TransferHub } from '../transfer/TransferHub'
import type { BrowserWindow } from 'electron'
import type { PasswordVault } from '../db/passwordVault'
import type { LocalFileSystem } from '../local/LocalFileSystem'

const K = 'me@nas.local:21'

describe('event bridges after the window is closed', () => {
  it('drops ftp, transfer and operation events instead of sending to a destroyed window', async () => {
    // covers: Test-634
    let destroyed = false
    const send = vi.fn((channel: string) => {
      // Electron이 파괴된 창의 webContents에 send하면 던지는 것과 같다
      if (destroyed) throw new TypeError(`Object has been destroyed (${channel})`)
    })
    const win = { isDestroyed: () => destroyed, webContents: { send } } as unknown as BrowserWindow
    const operations = registerOperationHandlers(win)
    const registry = new ConnectionRegistry((key) => fakeSession(key))
    const hub = new TransferHub(registry)
    registerFtpHandlers(win, operations, {} as PasswordVault, registry)
    registerTransferHandlers(win, registry, hub, {} as LocalFileSystem)
    await registry.connect(payloadOf(K))
    send.mockClear()
    const session = registry.get(K)!
    const emitAll = (): void => {
      remoteOf(session).setStatus('connected', 'h')
      session.queue.emit('queue:updated', { upserts: [], removedIds: [] })
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

  it('forwards every FTP mutation as ftp:remoteChanged until the window is closed', async () => {
    // covers: Test-412
    let destroyed = false
    const send = vi.fn()
    const win = { isDestroyed: () => destroyed, webContents: { send } } as unknown as BrowserWindow
    const registry = new ConnectionRegistry((key) => fakeSession(key))
    registerFtpHandlers(win, registerOperationHandlers(win), {} as PasswordVault, registry)
    await registry.connect(payloadOf(K))
    send.mockClear()
    const manager = registry.get(K)!.manager

    manager.emit('mutation', { kind: 'upload', remotePath: '/a.jpg' })
    destroyed = true
    manager.emit('mutation', { kind: 'delete', remotePath: '/b' })

    expect(send.mock.calls).toEqual([
      ['ftp:remoteChanged', { kind: 'upload', remotePath: '/a.jpg', server: 'me@nas.local:21' }]
    ])
  })
})
