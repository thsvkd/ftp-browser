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
import { ConnectionRegistry } from '../ftp/ConnectionRegistry'
import {
  fakeSession,
  payloadOf,
  remoteOf,
  type FakeConnection
} from '../ftp/__fixtures__/fakeSessions'
import { TransferClientPool } from '../transfer/TransferClientPool'
import { TransferHub } from '../transfer/TransferHub'
import { TransferQueue } from '../transfer/TransferQueue'
import type { BrowserWindow } from 'electron'
import type { FtpFileOperations } from '../ftp/FtpFileOperations'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import type { ConnKey } from '@shared/connKey'
import type { IpcResult } from '@shared/types/ipc'
import type {
  TransferJob,
  TransferSendRequest,
  TransferSendResult,
  TransferUpdate
} from '@shared/types/transfer'

const K = 'me@nas.local:21'

describe('registerTransferHandlers', () => {
  let manager: FakeConnection
  let registry: ConnectionRegistry
  let hub: TransferHub
  let queue: TransferQueue
  let fileOps: { upload: ReturnType<typeof vi.fn>; download: ReturnType<typeof vi.fn> }
  let client: { closed: boolean; close: () => void; sendIgnoringError: ReturnType<typeof vi.fn> }
  let winSend: ReturnType<typeof vi.fn>
  let tmp: string

  beforeEach(async () => {
    vi.useFakeTimers()
    handlers.clear()
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-ipc-'))
    client = {
      closed: false,
      close: vi.fn(),
      sendIgnoringError: vi.fn().mockResolvedValue({ code: 257, message: '257 created' })
    }
    fileOps = {
      upload: vi.fn().mockResolvedValue(undefined),
      download: vi.fn().mockResolvedValue(undefined)
    }
    // 연결마다 진짜 큐·풀. 매니저는 메모리 원격 트리이고 보조 연결은 가짜 클라이언트를 준다
    registry = new ConnectionRegistry((key: ConnKey) => {
      const session = fakeSession(key)
      const remote = Object.assign(remoteOf(session), {
        createSecondaryClient: vi.fn().mockResolvedValue(client),
        getMaxTransfers: vi.fn(() => 16)
      })
      const pool = new TransferClientPool(remote as unknown as FtpConnectionManager)
      const ops = fileOps as unknown as FtpFileOperations
      return { ...session, pool, queue: new TransferQueue(ops, pool, { server: key }) }
    })
    hub = new TransferHub(registry)
    winSend = vi.fn()
    registerTransferHandlers(
      { isDestroyed: () => false, webContents: { send: winSend } } as unknown as BrowserWindow,
      registry,
      hub,
      new LocalFileSystem()
    )
    await registry.connect(payloadOf(K))
    manager = remoteOf(registry.get(K))
    queue = registry.get(K)!.queue
  })

  afterEach(async () => {
    vi.useRealTimers()
    await fs.rm(tmp, { recursive: true, force: true })
  })

  const at = (...parts: string[]): string => path.join(tmp, ...parts)

  function sendTo(
    conn: unknown,
    request: TransferSendRequest
  ): Promise<IpcResult<TransferSendResult>> {
    return handlers.get('transfer:send')!({}, conn, request) as Promise<
      IpcResult<TransferSendResult>
    >
  }
  const send = (request: TransferSendRequest): Promise<IpcResult<TransferSendResult>> =>
    sendTo(K, request)

  it('passes remoteDirs to the queue of that connection', async () => {
    const enqueue = handlers.get('transfer:enqueueBatch')!
    const result = enqueue({}, K, {
      direction: 'upload',
      items: [
        { localPath: '/l/a', remotePath: '/t/d/a', fileName: 'a', totalBytes: 1 },
        { localPath: '/l/b', remotePath: '/t/d/b', fileName: 'b', totalBytes: 1 }
      ],
      forceBatch: true,
      remoteDirs: ['/t/d']
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(result).toMatchObject({ success: true })
    expect(client.sendIgnoringError).toHaveBeenCalledWith('MKD /t/d')
    expect(queue.getAll().map((job) => job.server)).toEqual([K, K])
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

    expect(disconnected).toEqual({
      success: false,
      error: `Not connected to ${K}.`,
      code: 'FTP_NOT_CONNECTED'
    })
    await expect(missing).resolves.toMatchObject({ success: false, error: expect.any(String) })
    expect(queue.getAll()).toEqual([])
  })

  it('retries the given ids through the hub', async () => {
    // covers: Test-767
    const retry = vi.spyOn(hub, 'retry')

    const result = await handlers.get('transfer:retry')!({}, ['a', 'b'])

    expect(retry).toHaveBeenCalledWith(['a', 'b'])
    expect(result).toEqual({ success: true, data: undefined })
  })
})

describe('transfer channels with two connections', () => {
  const A = 'me@a.example:21'
  const B = 'you@b.example:2121'
  let registry: ConnectionRegistry
  let hub: TransferHub
  let winSend: ReturnType<typeof vi.fn>
  let tmp: string
  const fileOpsOf = new Map<ConnKey, { download: ReturnType<typeof vi.fn> }>()

  beforeEach(async () => {
    vi.useFakeTimers()
    handlers.clear()
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-ipc2-'))
    registry = new ConnectionRegistry((key: ConnKey) => {
      const session = fakeSession(key)
      const remote = Object.assign(remoteOf(session), {
        createSecondaryClient: vi.fn(async () => ({ closed: false, close: vi.fn() })),
        getMaxTransfers: vi.fn(() => 1)
      })
      // 다운로드는 550으로 바로 실패한다(재시도 없이 failed): retry를 부를 수 있다
      const ops = {
        download: vi.fn().mockRejectedValue(Object.assign(new Error('550 denied'), { code: 550 }))
      }
      fileOpsOf.set(key, ops)
      const pool = new TransferClientPool(remote as unknown as FtpConnectionManager)
      const queue = new TransferQueue(ops as unknown as FtpFileOperations, pool, { server: key })
      return { ...session, pool, queue }
    })
    hub = new TransferHub(registry)
    winSend = vi.fn()
    registerTransferHandlers(
      { isDestroyed: () => false, webContents: { send: winSend } } as unknown as BrowserWindow,
      registry,
      hub,
      new LocalFileSystem()
    )
    await registry.connect(payloadOf(A))
    await registry.connect(payloadOf(B))
    for (const key of [A, B]) remoteOf(registry.get(key)).addDir('/r').addFile('/r/a.jpg', 10)
  })

  afterEach(async () => {
    vi.useRealTimers()
    await fs.rm(tmp, { recursive: true, force: true })
  })

  const invoke = <T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> =>
    Promise.resolve(handlers.get(channel)!({}, ...args) as IpcResult<T>)

  it("plans a send with that key's listing and queues it on that key's queue only", async () => {
    // covers: Test-978
    const enqueueA = vi.spyOn(registry.get(A)!.queue, 'enqueueBatch')

    const result = await invoke<TransferSendResult>('transfer:send', B, {
      direction: 'download',
      sources: ['/r'],
      destDir: tmp
    })

    expect(remoteOf(registry.get(B)).list).toHaveBeenCalledWith('/r')
    expect(remoteOf(registry.get(A)).list).not.toHaveBeenCalled()
    expect(enqueueA).not.toHaveBeenCalled()
    expect(registry.get(A)!.queue.getAll()).toEqual([])
    const { batchId, ids } = (result as { data: TransferSendResult }).data
    const jobs = registry.get(B)!.queue.getAll()
    expect(batchId).toEqual(expect.any(String))
    expect(jobs.map((job) => [job.id, job.batchId, job.server])).toEqual([[ids[0], batchId, B]])
  })

  it('reaches the jobs of both connections through cancel, retry, clearCompleted and getAll', async () => {
    // covers: Test-979
    const item = { localPath: '/l/a', remotePath: '/r/a.jpg', fileName: 'a.jpg', totalBytes: 10 }
    // 동기 핸들러라 곧바로 부른다: b2가 시작하기 전에 취소한다
    const call = (channel: string, ...args: unknown[]): unknown =>
      handlers.get(channel)!({}, ...args)
    const enqueue = (conn: ConnKey, n: number): string[] =>
      (
        call('transfer:enqueueBatch', conn, {
          direction: 'download',
          items: Array(n).fill(item)
        }) as { data: string[] }
      ).data
    const [a1] = enqueue(A, 1)
    const [b1, b2] = enqueue(B, 2)
    expect(call('transfer:cancel', b2)).toEqual({ success: true, data: undefined })
    await vi.advanceTimersByTimeAsync(200)

    const all = (await invoke<TransferJob[]>('transfer:getAll')) as { data: TransferJob[] }
    expect(all.data.map((job) => [job.id, job.server, job.status])).toEqual([
      [a1, A, 'failed'],
      [b1, B, 'failed'],
      [b2, B, 'cancelled']
    ])
    const updated = winSend.mock.calls
      .filter(([channel]) => channel === 'transfer:updated')
      .flatMap(([, update]) => (update as TransferUpdate).upserts.map((job) => job.id))
    expect(new Set(updated)).toEqual(new Set([a1, b1, b2]))

    await invoke('transfer:retry', [a1, b1])
    expect(fileOpsOf.get(A)!.download).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(fileOpsOf.get(A)!.download).toHaveBeenCalledTimes(2)
    expect(fileOpsOf.get(B)!.download).toHaveBeenCalledTimes(2)

    await invoke('transfer:clearCompleted')
    expect(
      ((await invoke<TransferJob[]>('transfer:getAll')) as { data: TransferJob[] }).data
    ).toEqual([])
  })
})
