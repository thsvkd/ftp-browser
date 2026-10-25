import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  },
  BrowserWindow: class {},
  app: { getPath: vi.fn(() => os.tmpdir()) }
}))

import { registerTransferHandlers } from './transferHandlers'
import { LocalFileSystem } from '../local/LocalFileSystem'
import { FakeRemote } from '../mcp/__fixtures__/agentHarness'
import { FtpSessionRegistry } from '../ftp/FtpSessionRegistry'
import { EventEmitter } from 'events'
import type { BrowserWindow } from 'electron'
import type { FtpFileOperations } from '../ftp/FtpFileOperations'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import type { TransferQueue } from '../transfer/TransferQueue'
import type { IpcResult } from '@shared/types/ipc'
import type { FtpConnectPayload } from '@shared/types/ftp'
import type { TransferSendRequest, TransferSendResult } from '@shared/types/transfer'

/** primary 세션의 로그인(가짜 매니저의 host·user와 맞춘다). */
const PRIMARY_LOGIN: FtpConnectPayload = {
  host: 'nas.local',
  port: 21,
  user: 'me',
  password: 'x',
  secure: false
}

/** 세션 하나의 가짜 매니저: 목록과 연결 여부를 세션마다 구분해 관찰한다. 풀 클라이언트를 주면 그걸 쓴다. */
function sessionManager(
  host: string,
  connected: boolean,
  transferClient?: {
    closed: boolean
    close: () => void
    sendIgnoringError: ReturnType<typeof vi.fn>
  }
): {
  manager: FtpConnectionManager
  list: ReturnType<typeof vi.fn>
} {
  const client = transferClient ?? { closed: false, close: vi.fn(), sendIgnoringError: vi.fn() }
  const list = vi.fn(async (dir: string) => ({ path: dir, entries: [] }))
  const manager = Object.assign(new EventEmitter(), {
    isConnected: () => connected,
    getHost: () => host,
    getPort: () => 21,
    getUser: () => 'user',
    getStatus: () => (connected ? 'connected' : 'disconnected'),
    getMaxTransfers: () => 16,
    list,
    createSecondaryClient: vi.fn(async () => client),
    runOnMainClient: vi.fn()
  }) as unknown as FtpConnectionManager
  return { manager, list }
}

describe('registerTransferHandlers', () => {
  let manager: FakeRemote
  let registry: FtpSessionRegistry
  let queue: TransferQueue
  let sendSpy: ReturnType<typeof vi.fn>
  let client: { closed: boolean; close: () => void; sendIgnoringError: ReturnType<typeof vi.fn> }
  let tmp: string

  beforeEach(async () => {
    vi.useFakeTimers()
    handlers.clear()
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-ipc-'))
    sendSpy = vi.fn()
    client = {
      closed: false,
      close: vi.fn(),
      sendIgnoringError: vi.fn().mockResolvedValue({ code: 257, message: '257 created' })
    }
    manager = Object.assign(new FakeRemote(), {
      createSecondaryClient: vi.fn().mockResolvedValue(client),
      getMaxTransfers: vi.fn(() => 16)
    })
    const fileOps = {
      upload: vi.fn().mockResolvedValue(undefined),
      download: vi.fn().mockResolvedValue(undefined)
    }
    // 인자를 안 주는 send는 primary(이 가짜 매니저)를 쓴다 — 기존 동작과 같다(M3).
    registry = new FtpSessionRegistry()
    registry.put(PRIMARY_LOGIN, manager as unknown as FtpConnectionManager)
    queue = registerTransferHandlers(
      { isDestroyed: () => false, webContents: { send: sendSpy } } as unknown as BrowserWindow,
      fileOps as unknown as FtpFileOperations,
      registry,
      new LocalFileSystem()
    )
  })

  afterEach(async () => {
    vi.useRealTimers()
    await fs.rm(tmp, { recursive: true, force: true })
  })

  const at = (...parts: string[]): string => path.join(tmp, ...parts)

  function send(
    request: TransferSendRequest,
    server?: string
  ): Promise<IpcResult<TransferSendResult>> {
    return handlers.get('transfer:send')!({}, request, server) as Promise<
      IpcResult<TransferSendResult>
    >
  }

  it('passes remoteDirs to the queue and announces each created dir as a mkdir mutation', async () => {
    const mutations: unknown[] = []
    // 큐는 레지스트리(위임) 위에서 변경을 알린다
    registry.on('mutation', (event) => mutations.push(event))

    const enqueue = handlers.get('transfer:enqueueBatch')!
    const result = enqueue(
      {},
      {
        direction: 'upload',
        items: [
          { localPath: '/l/a', remotePath: '/t/d/a', fileName: 'a', totalBytes: 1 },
          { localPath: '/l/b', remotePath: '/t/d/b', fileName: 'b', totalBytes: 1 }
        ],
        forceBatch: true,
        remoteDirs: ['/t/d']
      }
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(result).toMatchObject({ success: true })
    expect(client.sendIgnoringError).toHaveBeenCalledWith('MKD /t/d')
    // M5: 변경 알림에는 그 세션 태그가 붙는다(이 큐는 primary 세션의 것이다)
    expect(mutations).toEqual([{ kind: 'mkdir', remotePath: '/t/d', server: 'me@nas.local:21' }])
  })

  it('enqueues a send without conflicts as one forced batch, downloads without exclusive', async () => {
    // covers: Test-763
    const enqueueBatch = vi.spyOn(queue, 'enqueueBatch')
    await fs.writeFile(at('one.txt'), 'abc')
    manager.addDir('/dest').addDir('/r').addFile('/r/a.jpg', 10)

    const up = await send({ direction: 'upload', sources: [at('one.txt')], destDir: '/dest' })
    const down = await send({ direction: 'download', sources: ['/r'], destDir: at('new') })

    const upItem = { localPath: at('one.txt'), remotePath: '/dest/one.txt', fileName: 'one.txt' }
    expect(enqueueBatch).toHaveBeenNthCalledWith(
      1,
      'upload',
      [{ ...upItem, totalBytes: 3 }],
      true,
      []
    )
    const downItem = {
      remotePath: '/r/a.jpg',
      localPath: at('new', 'r', 'a.jpg'),
      fileName: 'a.jpg'
    }
    expect(enqueueBatch).toHaveBeenNthCalledWith(
      2,
      'download',
      [{ ...downItem, totalBytes: 10 }],
      true,
      undefined
    )
    const jobs = queue.getAll()
    expect(up).toEqual({
      success: true,
      data: {
        batchId: jobs[0].batchId,
        ids: [jobs[0].id],
        skipped: [],
        conflicts: [],
        totalBytes: 3
      }
    })
    expect(down).toMatchObject({
      success: true,
      data: { batchId: jobs[1].batchId, ids: [jobs[1].id], conflicts: [], totalBytes: 10 }
    })
    expect(jobs[0].batchId).toEqual(expect.any(String))
    expect(jobs[1].batchId).toEqual(expect.any(String))
    expect((await fs.stat(at('new', 'r'))).isDirectory()).toBe(true)
  })

  it('returns only the conflicts and touches neither the queue nor the disk without decisions', async () => {
    // covers: Test-764
    const enqueueBatch = vi.spyOn(queue, 'enqueueBatch')
    await fs.mkdir(at('r'))
    await fs.writeFile(at('r', 'a.jpg'), 'mine')
    manager.addDir('/r').addFile('/r/a.jpg', 10).addDir('/r/new').addFile('/r/new/b.jpg', 20)

    const result = await send({ direction: 'download', sources: ['/r'], destDir: tmp })

    expect(result).toEqual({
      success: true,
      data: {
        ids: [],
        skipped: [],
        conflicts: [
          {
            target: at('r', 'a.jpg'),
            source: '/r/a.jpg',
            name: 'a.jpg',
            incoming: { size: 10, modifiedAt: '' },
            existing: { size: 4, modifiedAt: expect.any(String) }
          }
        ],
        totalBytes: 20
      }
    })
    expect(enqueueBatch).not.toHaveBeenCalled()
    expect(queue.getAll()).toEqual([])
    await expect(fs.stat(at('r', 'new'))).rejects.toThrow()
  })

  it('enqueues the resolved plan once every conflict is decided and asks again about new ones', async () => {
    // covers: Test-765
    const enqueueBatch = vi.spyOn(queue, 'enqueueBatch')
    await fs.writeFile(at('a.jpg'), 'mine')
    manager.addFile('/a.jpg', 10).addFile('/b.jpg', 20).addFile('/c.jpg', 30)
    const request = { direction: 'download' as const, sources: ['/a.jpg', '/b.jpg', '/c.jpg'] }

    const first = await send({ ...request, destDir: tmp })
    expect(first).toMatchObject({ data: { conflicts: [{ target: at('a.jpg') }] } })

    // 그사이 b.jpg가 로컬에 생겼다: a만 결정한 두 번째 요청은 b만 묻는다
    await fs.writeFile(at('b.jpg'), 'mine too')
    const second = await send({ ...request, destDir: tmp, decisions: { [at('a.jpg')]: 'skip' } })
    expect(second).toMatchObject({
      success: true,
      data: { ids: [], conflicts: [{ target: at('b.jpg') }] }
    })
    expect((second as { data: TransferSendResult }).data.conflicts).toHaveLength(1)
    expect(enqueueBatch).not.toHaveBeenCalled()

    const third = await send({
      ...request,
      destDir: tmp,
      decisions: { [at('a.jpg')]: 'skip', [at('b.jpg')]: 'rename', [at('zzz')]: 'overwrite' }
    })

    expect(enqueueBatch).toHaveBeenCalledTimes(1)
    expect(enqueueBatch.mock.calls[0][1].map((i) => [i.remotePath, i.localPath])).toEqual([
      ['/c.jpg', at('c.jpg')],
      ['/b.jpg', at('b (1).jpg')]
    ])
    expect(third).toMatchObject({
      success: true,
      data: {
        ids: expect.arrayContaining([expect.any(String)]),
        skipped: [{ path: '/a.jpg', reason: 'already exists in the local folder' }],
        conflicts: [],
        totalBytes: 50
      }
    })
  })

  it('returns failures as values when disconnected or when a listing fails while planning', async () => {
    // covers: Test-766
    manager.connected = false
    const disconnected = await send({ direction: 'upload', sources: [tmp], destDir: '/' })
    manager.connected = true
    const missing = send({ direction: 'download', sources: ['/missing/a.jpg'], destDir: tmp })

    expect(disconnected).toMatchObject({ success: false, code: 'FTP_NOT_CONNECTED' })
    await expect(missing).resolves.toMatchObject({ success: false, error: expect.any(String) })
    expect(queue.getAll()).toEqual([])
  })

  it('retries the given ids through the queue', async () => {
    // covers: Test-767
    const retry = vi.spyOn(queue, 'retry')

    const result = await handlers.get('transfer:retry')!({}, ['a', 'b'])

    expect(retry).toHaveBeenCalledWith(['a', 'b'])
    expect(result).toEqual({ success: true, data: undefined })
  })

  it('plans on the requested session manager and refuses a session that is not open', async () => {
    // covers: Test-912
    await fs.writeFile(at('one.txt'), 'abc')
    const openSession = sessionManager('other.example', true)
    registry.put({ ...PRIMARY_LOGIN, host: 'other.example', user: 'other' }, openSession.manager)
    const closedSession = sessionManager('closed.example', false)
    registry.put({ ...PRIMARY_LOGIN, host: 'closed.example', user: 'down' }, closedSession.manager)
    // put 순서상 primary = 닫힌 세션: 인자를 생략한 호출이 primary를 쓰는지도 함께 확인한다

    const up = await send(
      { direction: 'upload', sources: [at('one.txt')], destDir: '/dest' },
      'other@other.example:21'
    )
    expect(up).toMatchObject({
      success: true,
      data: { ids: [expect.any(String)], conflicts: [] }
    })
    // 충돌 판단은 그 세션의 목록으로만 했다(primary·닫힌 세션의 목록은 보지 않는다)
    expect(openSession.list).toHaveBeenCalledWith('/dest')
    expect(manager.list).not.toHaveBeenCalled()
    expect(closedSession.list).not.toHaveBeenCalled()

    // 그 세션이 안 열려 있으면FTP_NOT_CONNECTED
    await expect(
      send(
        { direction: 'upload', sources: [at('one.txt')], destDir: '/dest' },
        'down@closed.example:21'
      )
    ).resolves.toMatchObject({ success: false, code: 'FTP_NOT_CONNECTED' })

    // 인자를 생략하면 primary
    await expect(
      send({ direction: 'upload', sources: [at('one.txt')], destDir: '/dest' })
    ).resolves.toMatchObject({ success: false, code: 'FTP_NOT_CONNECTED' })
  })

  it("executes a non-primary session's enqueue on that session's pool, tagged with its key", async () => {
    // covers: Test-934
    const sessionClient = {
      closed: false,
      close: vi.fn(),
      sendIgnoringError: vi.fn().mockResolvedValue({ code: 257, message: '257 created' })
    }
    const other = sessionManager('other.example', true, sessionClient)
    registry.put({ ...PRIMARY_LOGIN, host: 'other.example', user: 'other' }, other.manager)
    // put은 primary를 바꾸므로 되돌린다: 세션 인자를 준 호출만 그 세션의 큐로 가야 한다(M3)
    registry.put(PRIMARY_LOGIN, manager as unknown as FtpConnectionManager)

    const result = handlers.get('transfer:enqueueBatch')!(
      {},
      {
        direction: 'upload',
        items: [{ localPath: '/l/a', remotePath: '/t/d/a', fileName: 'a', totalBytes: 1 }],
        forceBatch: true,
        remoteDirs: ['/t/d']
      },
      'other@other.example:21'
    )
    await vi.advanceTimersByTimeAsync(100)

    expect(result).toMatchObject({ success: true })
    // 실행(원격 폴더 생성)은 그 세션의 풀 클라이언트로 갔다 — primary의 클라이언트는 쓰이지 않는다
    expect(other.manager.createSecondaryClient).toHaveBeenCalled()
    expect(sessionClient.sendIgnoringError).toHaveBeenCalledWith('MKD /t/d')
    const primaryAcquire = (
      manager as unknown as { createSecondaryClient: ReturnType<typeof vi.fn> }
    ).createSecondaryClient
    expect(primaryAcquire).not.toHaveBeenCalled()
    expect(client.sendIgnoringError).not.toHaveBeenCalled()
    // 진행 알림도 그 세션 태그를 싣고 나온다(M5)
    expect(sendSpy).toHaveBeenCalledWith(
      'transfer:updated',
      expect.objectContaining({ server: 'other@other.example:21' })
    )
  })
})
