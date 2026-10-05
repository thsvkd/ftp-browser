import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { attachRemoteChangeForwarding, createAgentEventSink, type AgentEventWindow } from './events'

function fakeWindow(): AgentEventWindow & { destroyed: boolean; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  const win = {
    destroyed: false,
    send,
    isDestroyed: () => win.destroyed,
    webContents: { send }
  }
  return win
}

describe('agent events', () => {
  it('forwards every FTP mutation as ftp:remoteChanged, skipping a missing or destroyed window', () => {
    // covers: Test-412
    const manager = new EventEmitter()
    const win = fakeWindow()
    let current: AgentEventWindow | null = win
    const sink = createAgentEventSink(() => current)
    const detach = attachRemoteChangeForwarding(manager, sink)

    manager.emit('mutation', { kind: 'upload', remotePath: '/a.jpg' })
    expect(win.send).toHaveBeenCalledWith('ftp:remoteChanged', {
      kind: 'upload',
      remotePath: '/a.jpg'
    })

    sink.localChanged({ paths: ['/home/me/x'] })
    sink.session({ status: 'disconnected' })
    expect(win.send).toHaveBeenCalledWith('local:changed', { paths: ['/home/me/x'] })
    expect(win.send).toHaveBeenCalledWith('agent:session', { status: 'disconnected' })

    win.send.mockClear()
    win.destroyed = true
    manager.emit('mutation', { kind: 'delete', remotePath: '/b' })
    sink.session({ status: 'disconnected' })
    current = null
    manager.emit('mutation', { kind: 'delete', remotePath: '/c' })
    expect(win.send).not.toHaveBeenCalled()

    current = fakeWindow()
    detach()
    manager.emit('mutation', { kind: 'mkdir', remotePath: '/d' })
    expect((current as ReturnType<typeof fakeWindow>).send).not.toHaveBeenCalled()
  })
})
