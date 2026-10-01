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

// 분할 대상 기준을 1 MiB로 낮춰 5 MiB 파일이 분할 후보가 되게 한다. 느린 CI에서도 벽시계에 흔들리지 않게
// LAN 판정(SIZE 2 ms 안)과 속도 판정(100 ms 뒤)은 넉넉히 늘린다: 루프백 SIZE는 늘 LAN으로 보이고, 5 MiB는
// 판정 전에 끝나므로 한 스트림 경로만 탄다. 두 판정의 경계는 TransferQueue.test.ts가 확인한다.
vi.mock('./segmentedDownload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./segmentedDownload')>()
  return {
    ...actual,
    LAN_RTT_MS: 5_000,
    PROBE_MS: 60_000,
    SEGMENT_MIN: 1024 * 1024,
    planSegments: (size: number, limit: number, minSize = 1024 * 1024) =>
      actual.planSegments(size, limit, minSize, (5 * 1024 * 1024) / 4)
  }
})

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 구간이 엉뚱한 위치에 써지면 해시가 반드시 달라지는 의사 난수 내용 */
function sourceFile(): Buffer {
  const data = Buffer.alloc(FILE_SIZE)
  let x = 0x9e3779b9
  for (let i = 0; i < data.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    data[i] = x >>> 24
  }
  return data
}

describe('LAN download against a loopback mock FTP server', () => {
  const source = sourceFile()
  let server: MockFtpServer
  let pool: TransferClientPool
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'landl-'))
  })

  afterEach(async () => {
    pool.dispose()
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('should receive a split-sized file over one RETR without REST when SIZE answers at LAN speed', async () => {
    server = await startMockFtpServer({ file: source })
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
    const queue = new TransferQueue(new FtpFileOperations(manager), pool)

    const localPath = path.join(dir, 'big.bin')
    queue.enqueue('download', localPath, '/big.bin', 'big.bin', FILE_SIZE)
    await vi.waitFor(
      () => {
        const job = queue.getAll()[0]
        if (job.status === 'failed') throw new Error(job.error)
        expect(job.status).toBe('completed')
      },
      { timeout: 15_000, interval: 20 }
    )

    expect(sha256(fs.readFileSync(localPath))).toBe(sha256(source))
    const received = server.log.filter((line) => line.startsWith('< '))
    expect(received).toContain('< SIZE /big.bin')
    expect(received.filter((line) => line.startsWith('< RETR'))).toHaveLength(1)
    expect(received.filter((line) => line.startsWith('< REST'))).toHaveLength(0)
    expect(queue.getAll()[0].transferredBytes).toBe(FILE_SIZE)
  })
})
