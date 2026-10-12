import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Client } from 'basic-ftp'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  },
  BrowserWindow: class {},
  app: { getPath: vi.fn(() => os.tmpdir()) }
}))

import { registerTransferHandlers } from '../ipc/transferHandlers'
import { ConnectionRegistry } from '../ftp/ConnectionRegistry'
import { FtpFileOperations } from '../ftp/FtpFileOperations'
import { fakeSession, payloadOf } from '../ftp/__fixtures__/fakeSessions'
import { LocalFileSystem } from '../local/LocalFileSystem'
import { startMockFtpServer, type MockFtpServer } from './__fixtures__/mockFtpServer'
import { TransferClientPool } from './TransferClientPool'
import { TransferHub } from './TransferHub'
import { TransferQueue } from './TransferQueue'
import type { BrowserWindow } from 'electron'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import type { IpcResult } from '@shared/types/ipc'
import type { TransferSendResult, TransferUpdate } from '@shared/types/transfer'

const K = 'u@127.0.0.1:21'

describe('transfer:send upload of dropped items against a mock FTP server', () => {
  let server: MockFtpServer
  let dir: string
  let queue: TransferQueue
  let onStatus: Array<(state: { status: string }) => void>

  afterEach(async () => {
    // 남은 작업을 끝내고 풀의 연결을 닫는다(앱이 연결을 끊을 때와 같은 경로). 다음 테스트로 핸들이 새지 않게
    for (const job of queue.getAll()) queue.cancel(job.id)
    for (const fn of onStatus) fn({ status: 'disconnected' })
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('sends a folder and a file as one batch and reports byte progress', async () => {
    // covers: Test-1101
    // 느린 업링크: 서버가 5ms마다 64KiB씩만 읽는다. 양 끝 소켓 버퍼(Linux는 합쳐 10MB까지)가 다 받아 내지 못할 만큼 크게 보낸다
    server = await startMockFtpServer({ storPace: { bytes: 64 * 1024, ms: 5 } })
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-upload-int-'))
    onStatus = []
    fs.mkdirSync(path.join(dir, 'folder'))
    fs.writeFileSync(path.join(dir, 'folder', 'big.bin'), Buffer.alloc(24 * 1024 * 1024, 7))
    fs.writeFileSync(path.join(dir, 'loose.bin'), Buffer.alloc(64 * 1024, 1))
    const manager = {
      isConnected: () => true,
      // 모의 서버에는 LIST가 없다: 원격 대상 폴더는 비어 있다
      list: async () => ({ entries: [] }),
      createSecondaryClient: async () => {
        const client = new Client(10_000, { allowSeparateTransferHost: false })
        client.ftp.ipFamily = 4
        await client.access({ host: '127.0.0.1', port: server.port, user: 'u', password: 'p' })
        return client
      },
      getMaxTransfers: () => 4,
      on: vi.fn((event: string, fn: (state: { status: string }) => void) => {
        if (event === 'connectionStatus') onStatus.push(fn)
      }),
      off: vi.fn(),
      emit: vi.fn(),
      runOnMainClient: vi.fn()
    } as unknown as FtpConnectionManager
    const updates: TransferUpdate[] = []
    const win = {
      isDestroyed: () => false,
      webContents: { send: (_channel: string, update: TransferUpdate) => updates.push(update) }
    } as unknown as BrowserWindow
    // 연결 하나의 세션: 진짜 파일 작업·풀·큐가 모의 서버로 간다(앱의 createSession과 같은 조립)
    const registry = new ConnectionRegistry((key) => {
      const fileOps = new FtpFileOperations(manager)
      const pool = new TransferClientPool(manager)
      queue = new TransferQueue(fileOps, pool, { server: key })
      return { ...fakeSession(key), manager, fileOps, pool, queue }
    })
    registerTransferHandlers(win, registry, new TransferHub(registry), new LocalFileSystem())
    await registry.connect(payloadOf(K))

    const res = (await handlers.get('transfer:send')!({}, K, {
      direction: 'upload',
      sources: [path.join(dir, 'folder'), path.join(dir, 'loose.bin')],
      destDir: '/dest'
    })) as IpcResult<TransferSendResult>
    if (!res.success) throw new Error(res.error)
    expect(res.data.conflicts).toEqual([])
    expect(res.data.ids).toHaveLength(2)

    const upserts = (): TransferUpdate['upserts'] => updates.flatMap((u) => u.upserts)
    await vi.waitFor(
      () => {
        const done = upserts().filter((j) => j.status === 'completed')
        expect(new Set(done.map((j) => j.id)).size).toBe(2)
      },
      { timeout: 20_000, interval: 20 }
    )
    expect(new Set(upserts().map((j) => j.batchId))).toEqual(new Set([res.data.batchId]))
    expect([...server.stored.keys()].sort()).toEqual(['/dest/folder/big.bin', '/dest/loose.bin'])
    expect(upserts().some((j) => j.transferredBytes > 0 && j.transferredBytes < j.totalBytes)).toBe(
      true
    )
  }, 30_000)
})
