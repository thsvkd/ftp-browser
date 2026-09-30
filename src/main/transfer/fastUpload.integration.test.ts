import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash, randomBytes } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Client } from 'basic-ftp'
import { TransferQueue } from './TransferQueue'
import { TransferClientPool } from './TransferClientPool'
import { FtpFileOperations } from '../ftp/FtpFileOperations'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import {
  startMockFtpServer,
  type MockFtpServer,
  type MockFtpServerOptions
} from './__fixtures__/mockFtpServer'

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

// 서버가 150을 늦게 보내야 빠른 경로가 150 전에 쓴 데이터("! early data")를 서버 쪽에서 볼 수 있다
const LATE_150 = { delay150Ms: 30 }

describe('fast uploads through the transfer queue against a mock FTP server', () => {
  let server: MockFtpServer
  let pool: TransferClientPool
  let queue: TransferQueue
  let dir: string

  async function setup(options: MockFtpServerOptions): Promise<void> {
    server = await startMockFtpServer(options)
    const manager = {
      createSecondaryClient: async () => {
        const client = new Client(10_000, { allowSeparateTransferHost: false })
        client.ftp.ipFamily = 4
        await client.access({ host: '127.0.0.1', port: server.port, user: 'u', password: 'p' })
        return client
      },
      getMaxTransfers: () => 16,
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      runOnMainClient: vi.fn()
    } as unknown as FtpConnectionManager
    pool = new TransferClientPool(manager)
    queue = new TransferQueue(new FtpFileOperations(manager), pool)
  }

  /** 파일 하나를 올리고 끝날 때까지 기다린다. 앞 업로드의 클라이언트가 idle로 돌아와 다시 쓰인다. */
  async function upload(name: string, size: number): Promise<Buffer> {
    const data = randomBytes(size)
    const localPath = path.join(dir, name)
    fs.writeFileSync(localPath, data)
    const id = queue.enqueue('upload', localPath, `/${name}`, name, size)
    await vi.waitFor(
      () => {
        const job = queue.getAll().find((j) => j.id === id)!
        if (job.status === 'failed') throw new Error(job.error)
        expect(job.status).toBe('completed')
      },
      { timeout: 10_000, interval: 10 }
    )
    return data
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastup-int-'))
  })

  afterEach(async () => {
    pool.dispose()
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('should upload byte-identical files, the second one through the fast flow', async () => {
    await setup(LATE_150)

    const first = await upload('a.bin', 700_000)
    const second = await upload('b.bin', 700_000)

    expect(sha256(server.stored.get('/a.bin')!)).toBe(sha256(first))
    expect(sha256(server.stored.get('/b.bin')!)).toBe(sha256(second))
    // 첫 전송은 basic-ftp가 수동 모드를 고르는 표준 경로, 같은 클라이언트의 두 번째는 빠른 경로다
    expect(server.log.filter((line) => line === '! early data')).toHaveLength(1)
    expect(server.log.filter((line) => line === '< USER u')).toHaveLength(1)
    expect(pool.fastBroken).toBe(false)
  })

  it('should fall back to the standard path when the server rejects the early upload with 425', async () => {
    await setup({ ...LATE_150, rejectEarlyData: true })

    await upload('a.bin', 100_000)
    const second = await upload('b.bin', 100_000)

    expect(server.log).toContain("> 425 Can't open data connection")
    expect(pool.fastBroken).toBe(true)
    expect(sha256(server.stored.get('/b.bin')!)).toBe(sha256(second))
    const job = queue.getAll()[1]
    expect(job.retryCount).toBeUndefined()
    expect(job.error).toBeUndefined()

    // 이후 업로드는 이 연결에서 표준 경로로만 간다
    const third = await upload('c.bin', 100_000)
    expect(sha256(server.stored.get('/c.bin')!)).toBe(sha256(third))
    expect(server.log.filter((line) => line.startsWith('> 425'))).toHaveLength(1)
  })
})
