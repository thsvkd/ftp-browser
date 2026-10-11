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
import type { BrowserWindow } from 'electron'
import type { FtpFileOperations } from '../ftp/FtpFileOperations'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import type { TransferQueue } from '../transfer/TransferQueue'
import type { IpcResult } from '@shared/types/ipc'
import type { TransferSendRequest, TransferSendResult } from '@shared/types/transfer'

describe('registerTransferHandlers', () => {
  let manager: FakeRemote
  let queue: TransferQueue
  let client: { closed: boolean; close: () => void; sendIgnoringError: ReturnType<typeof vi.fn> }
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
    manager = Object.assign(new FakeRemote(), {
      createSecondaryClient: vi.fn().mockResolvedValue(client),
      getMaxTransfers: vi.fn(() => 16)
    })
    const fileOps = {
      upload: vi.fn().mockResolvedValue(undefined),
      download: vi.fn().mockResolvedValue(undefined)
    }
    queue = registerTransferHandlers(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow,
      fileOps as unknown as FtpFileOperations,
      manager as unknown as FtpConnectionManager,
      new LocalFileSystem()
    )
  })

  afterEach(async () => {
    vi.useRealTimers()
    await fs.rm(tmp, { recursive: true, force: true })
  })

  const at = (...parts: string[]): string => path.join(tmp, ...parts)

  function send(request: TransferSendRequest): Promise<IpcResult<TransferSendResult>> {
    return handlers.get('transfer:send')!({}, request) as Promise<IpcResult<TransferSendResult>>
  }

  it('passes remoteDirs to the queue and announces each created dir as a mkdir mutation', async () => {
    const mutations: unknown[] = []
    manager.on('mutation', (event) => mutations.push(event))

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
    expect(mutations).toEqual([{ kind: 'mkdir', remotePath: '/t/d' }])
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
})
