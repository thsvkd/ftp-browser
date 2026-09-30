import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Client } from 'basic-ftp'
import { TransferQueue } from './TransferQueue'
import { TransferClientPool } from './TransferClientPool'
import { FtpFileOperations } from '../ftp/FtpFileOperations'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import { startMockFtpServer, type MockFtpServer } from './__fixtures__/mockFtpServer'

const MiB = 1024 * 1024
const FILE_SIZE = 5 * MiB

// 64 MiB 기준을 1 MiB로 낮추고 구간 크기를 1.25 MiB로 잡아, 5 MiB 파일이 4구간으로 나뉘게 한다.
vi.mock('./segmentedDownload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./segmentedDownload')>()
  return {
    ...actual,
    SEGMENT_MIN: 1024 * 1024,
    planSegments: (size: number, limit: number) =>
      actual.planSegments(size, limit, 1024 * 1024, (5 * 1024 * 1024) / 4)
  }
})

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 0..250 반복이 아닌 의사 난수 내용: 구간이 엉뚱한 위치에 써지면 해시가 반드시 달라진다. */
function sourceFile(): Buffer {
  const data = Buffer.alloc(FILE_SIZE)
  let x = 0x12345678
  for (let i = 0; i < data.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    data[i] = x >>> 24
  }
  return data
}

describe('segmented download against a mock FTP server', () => {
  const source = sourceFile()
  let server: MockFtpServer
  let pool: TransferClientPool
  let dir: string

  function setup(ignoreRest: boolean): Promise<TransferQueue> {
    return startMockFtpServer({ file: source, ignoreRest }).then((started) => {
      server = started
      const manager = {
        createSecondaryClient: async () => {
          const client = new Client(10_000)
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
      return new TransferQueue(new FtpFileOperations(manager), pool)
    })
  }

  async function download(queue: TransferQueue): Promise<string> {
    const localPath = path.join(dir, 'big.bin')
    queue.enqueue('download', localPath, '/big.bin', 'big.bin', FILE_SIZE)
    await vi.waitFor(
      () => {
        const status = queue.getAll()[0].status
        if (status === 'failed') throw new Error(queue.getAll()[0].error)
        expect(status).toBe('completed')
      },
      { timeout: 15_000, interval: 20 }
    )
    return localPath
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'segdl-'))
  })

  afterEach(async () => {
    pool.dispose()
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('should download a 5 MiB file in 4 segments that hashes the same as the source', async () => {
    const queue = await setup(false)
    const localPath = await download(queue)

    expect(sha256(fs.readFileSync(localPath))).toBe(sha256(source))
    // 앞 3구간은 REST로 이어 받고, 0부터 시작하는 첫 구간만 REST 없이 받는다
    const received = server.log.filter((line) => line.startsWith('< '))
    expect(received.filter((line) => line.startsWith('< RETR'))).toHaveLength(4)
    expect(
      received
        .filter((line) => line.startsWith('< REST'))
        .map((line) => Number(line.slice('< REST '.length)))
        .sort((a, b) => a - b)
    ).toEqual([1, 2, 3].map((i) => (FILE_SIZE / 4) * i))
    expect(queue.getAll()[0].transferredBytes).toBe(FILE_SIZE)
    expect(pool.segmentedBroken).toBe(false)
  })

  it('should fall back to one stream and still match the source when the server ignores REST', async () => {
    const queue = await setup(true)
    const localPath = await download(queue)

    expect(sha256(fs.readFileSync(localPath))).toBe(sha256(source))
    expect(fs.statSync(localPath).size).toBe(FILE_SIZE)
    expect(pool.segmentedBroken).toBe(true)
    expect(queue.getAll()[0].retryCount).toBeUndefined()
  })
})
