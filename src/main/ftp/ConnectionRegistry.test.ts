import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ConnectionRegistry,
  SessionError,
  createSession,
  type SessionShared
} from './ConnectionRegistry'
import { fakeSession, payloadOf, remoteOf } from './__fixtures__/fakeSessions'
import { ErrorCode } from '@shared/types/ipc'
import type { FtpConnectionState, RemoteChangedEvent } from '@shared/types/ftp'
import type { ThumbnailGenerator } from '../thumbnail/ThumbnailGenerator'
import type { CacheManager } from '../thumbnail/CacheManager'
import type { RemoteFolderPreviewCache } from './RemoteFolderPreviewCache'

const A = 'me@a.example:21'
const B = 'you@b.example:2121'

function registry(): ConnectionRegistry {
  return new ConnectionRegistry((key) => fakeSession(key))
}

describe('ConnectionRegistry.connect', () => {
  it('keeps a session per key and a second key does not touch the first', async () => {
    // covers: Test-962
    const reg = registry()

    await reg.connect(payloadOf(A))
    const first = remoteOf(reg.get(A))
    await reg.connect(payloadOf(B))

    expect(reg.sessions().map((s) => s.key)).toEqual([A, B])
    expect(reg.connectedKeys()).toEqual([A, B])
    expect(first.connect).toHaveBeenCalledTimes(1)
    expect(first.disconnect).not.toHaveBeenCalled()
    expect(reg.states()).toEqual([
      { server: A, status: 'connected', host: 'a.example', port: 21, user: 'me' },
      { server: B, status: 'connected', host: 'b.example', port: 2121, user: 'you' }
    ])
  })

  it('does not log in again to a connected key and shares one login between concurrent calls', async () => {
    // covers: Test-963
    const reg = registry()
    await reg.connect(payloadOf(A))
    const again = await reg.connect(payloadOf(A))

    expect(again).toEqual({ server: A, success: true })
    expect(remoteOf(reg.get(A)).connect).toHaveBeenCalledTimes(1)

    // 첫 로그인이 끝나기 전에 온 두 번째 호출은 같은 로그인을 기다린다
    let release!: () => void
    const fresh = new ConnectionRegistry((key) => {
      const session = fakeSession(key)
      remoteOf(session).connect.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve({ success: true })))
      )
      return session
    })
    const both = [fresh.connect(payloadOf(B)), fresh.connect(payloadOf(B))]
    await Promise.resolve()
    expect(remoteOf(fresh.get(B)).connect).toHaveBeenCalledTimes(1)
    release()
    const [r1, r2] = await Promise.all(both)
    expect(r1).toEqual({ server: B, success: true })
    expect(r2).toEqual(r1)
    expect(remoteOf(fresh.get(B)).connect).toHaveBeenCalledTimes(1)
  })

  it('disconnects one key only, reuses the same session on reconnect and ignores unknown keys', async () => {
    // covers: Test-964
    const reg = registry()
    await reg.connect(payloadOf(A))
    await reg.connect(payloadOf(B))
    const session = reg.get(A)!
    const queue = session.queue

    await reg.disconnect(A)
    expect(remoteOf(reg.get(A)).disconnect).toHaveBeenCalledTimes(1)
    expect(remoteOf(reg.get(B)).disconnect).not.toHaveBeenCalled()
    expect(reg.connectedKeys()).toEqual([B])

    await reg.connect(payloadOf(A))
    expect(reg.get(A)).toBe(session)
    expect(reg.get(A)!.queue).toBe(queue)
    expect(reg.connectedKeys()).toEqual([A, B])

    await expect(reg.disconnect('nobody@nowhere:21')).resolves.toBeUndefined()
    expect(reg.get('nobody@nowhere:21')).toBeUndefined()
    expect(reg.sessions()).toHaveLength(2)
  })
})

describe('ConnectionRegistry events', () => {
  it('re-emits each session status and mutation with its own server, host, port and user', async () => {
    // covers: Test-965
    const reg = registry()
    await reg.connect(payloadOf(A))
    await reg.connect(payloadOf(B))
    const states: FtpConnectionState[] = []
    const changes: RemoteChangedEvent[] = []
    reg.on('connectionStatus', (state: FtpConnectionState) => states.push(state))
    reg.on('mutation', (event: RemoteChangedEvent) => changes.push(event))

    remoteOf(reg.get(A)).setStatus('error', 'a.example', 'Connection closed by server.')
    remoteOf(reg.get(B)).emit('mutation', { kind: 'rename', remotePath: '/x', newPath: '/y' })
    remoteOf(reg.get(A)).emit('mutation', { kind: 'delete', remotePath: '/z' })
    remoteOf(reg.get(B)).setStatus('disconnected')

    expect(states).toEqual([
      {
        server: A,
        status: 'error',
        host: 'a.example',
        port: 21,
        user: 'me',
        error: 'Connection closed by server.'
      },
      { server: B, status: 'disconnected', host: 'b.example', port: 2121, user: 'you' }
    ])
    expect(changes).toEqual([
      { kind: 'rename', remotePath: '/x', newPath: '/y', server: B },
      { kind: 'delete', remotePath: '/z', server: A }
    ])
  })
})

describe('ConnectionRegistry.require', () => {
  it('throws FTP_NOT_CONNECTED naming the key, or an invalid-key error for a malformed key', async () => {
    // covers: Test-966
    const reg = registry()
    await reg.connect(payloadOf(A))
    await reg.connect(payloadOf(B))
    await reg.disconnect(B)

    expect(reg.require(A)).toBe(reg.get(A))
    for (const key of ['nobody@nowhere:21', B]) {
      let caught: unknown
      try {
        reg.require(key)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(SessionError)
      expect(caught).toMatchObject({ code: ErrorCode.FTP_NOT_CONNECTED })
      expect((caught as Error).message).toContain(key)
    }
    for (const key of [undefined, 42, '', 'no-at-sign:21', 'me@host:0', 'me@host:x']) {
      expect(() => reg.require(key)).toThrow('Invalid connection key.')
    }
  })
})

describe('createSession', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("announces the queue's created folders on its own manager and tags its jobs with its key", () => {
    // covers: Test-1031
    vi.useFakeTimers()
    const shared: SessionShared = {
      generator: {} as ThumbnailGenerator,
      cacheManager: {} as CacheManager,
      folderCache: {} as RemoteFolderPreviewCache,
      onThumbnailReady: vi.fn(),
      onThumbnailError: vi.fn()
    }
    const u = createSession('u@h:21', shared)
    const v = createSession('v@h:21', shared)
    const uChanges: unknown[] = []
    const vChanges: unknown[] = []
    u.manager.on('mutation', (event) => uChanges.push(event))
    v.manager.on('mutation', (event) => vChanges.push(event))

    u.queue.emit('dir:created', '/a/b')

    expect(uChanges).toEqual([{ kind: 'mkdir', remotePath: '/a/b' }])
    expect(vChanges).toEqual([])

    const [id] = u.queue.enqueueBatch('upload', [
      { localPath: '/l/a', remotePath: '/a/b/a', fileName: 'a', totalBytes: 1 }
    ])
    expect(u.queue.getAll().find((job) => job.id === id)?.server).toBe('u@h:21')
  })
})
