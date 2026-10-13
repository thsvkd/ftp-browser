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
import type { TransferJob, TransferUpdate } from '@shared/types/transfer'

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

// SEGMENT_MIN(64 MiB)보다 훨씬 작아 분할 다운로드가 끼지 않는다
const FILE = randomBytes(200 * 1024)

describe('transient disconnects are retried against a mock FTP server', () => {
  let server: MockFtpServer
  let pool: TransferClientPool
  let queue: TransferQueue
  let dir: string
  let updates: TransferJob[]

  async function setup(options: MockFtpServerOptions, maxTransfers = 16): Promise<void> {
    server = await startMockFtpServer({ file: FILE, ...options })
    const manager = {
      createSecondaryClient: async () => {
        const client = new Client(10_000, { allowSeparateTransferHost: false })
        client.ftp.ipFamily = 4
        await client.access({ host: '127.0.0.1', port: server.port, user: 'u', password: 'p' })
        return client
      },
      getMaxTransfers: () => maxTransfers,
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      runOnMainClient: vi.fn()
    } as unknown as FtpConnectionManager
    pool = new TransferClientPool(manager)
    queue = new TransferQueue(new FtpFileOperations(manager), pool)
    queue.on('queue:updated', (update: TransferUpdate) => updates.push(...update.upserts))
  }

  /** 파일 하나를 넣고 실패로 끝날 때까지 기다린다(재시도 3회, 실제 대기 6초). */
  async function downloadUntilFailed(localPath: string): Promise<TransferJob> {
    const id = queue.enqueue('download', localPath, '/file.bin', 'file.bin', FILE.length)
    await vi.waitFor(() => expect(queue.getAll().find((j) => j.id === id)!.status).toBe('failed'), {
      timeout: 15_000,
      interval: 10
    })
    return queue.getAll().find((j) => j.id === id)!
  }

  /** 파일 하나를 받아 끝날 때까지 기다린다. 재시도는 실제로 RETRY_DELAY_MS(2초)를 기다린다. */
  async function download(): Promise<{ job: TransferJob; localPath: string }> {
    const localPath = path.join(dir, 'file.bin')
    const id = queue.enqueue('download', localPath, '/file.bin', 'file.bin', FILE.length)
    await vi.waitFor(
      () => {
        const job = queue.getAll().find((j) => j.id === id)!
        if (job.status === 'failed') throw new Error(job.error)
        expect(job.status).toBe('completed')
      },
      { timeout: 10_000, interval: 10 }
    )
    return { job: queue.getAll().find((j) => j.id === id)!, localPath }
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-int-'))
    updates = []
  })

  afterEach(async () => {
    pool.dispose()
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('should retry a download whose passive mode is refused with 425 and finish it by itself', async () => {
    // covers: Test-1134
    await setup({ rejectPasv: 1 })

    const { job, localPath } = await download()

    expect(
      updates.some((j) => j.status === 'pending' && /^Retry 1\/3: .*425/.test(j.error ?? ''))
    ).toBe(true)
    expect(job.retryCount).toBe(1)
    expect(sha256(fs.readFileSync(localPath))).toBe(sha256(FILE))
    expect(server.log.filter((line) => line.startsWith('> 425'))).toHaveLength(1)
  }, 20_000)

  it('should retry a download cut by a server FIN from zero and keep no bytes of the cut attempt', async () => {
    // covers: Test-1135
    await setup({ finDuringRetr: 1 })

    const { job, localPath } = await download()

    expect(updates.map((j) => j.error)).toContain(
      'Retry 1/3: Server sent FIN packet unexpectedly, closing connection.'
    )
    expect(job.retryCount).toBe(1)
    expect(sha256(fs.readFileSync(localPath))).toBe(sha256(FILE))
    expect(server.log.filter((line) => line.startsWith('< RETR'))).toHaveLength(2)
  }, 20_000)

  it('should learn the data channel limit from a 425 and finish every file without a retry', async () => {
    // covers: Test-1196
    // 파일당 약 0.5초: 첫 시험 로그인 대기(2초) 안에 모두 끝나 limit가 2로 남는다
    await setup({ maxDataChannels: 2, retrPace: { bytes: 64 * 1024, ms: 150 } }, 3)
    const ids = queue.enqueueBatch(
      'download',
      [0, 1, 2].map((i) => ({
        localPath: path.join(dir, `file${i}.bin`),
        remotePath: `/file${i}.bin`,
        fileName: `file${i}.bin`,
        totalBytes: FILE.length
      }))
    )
    await vi.waitFor(
      () => {
        for (const id of ids) {
          const job = queue.getAll().find((j) => j.id === id)!
          if (job.status === 'failed') throw new Error(job.error)
          expect(job.status).toBe('completed')
        }
      },
      { timeout: 10_000, interval: 10 }
    )

    for (const i of [0, 1, 2]) {
      expect(sha256(fs.readFileSync(path.join(dir, `file${i}.bin`)))).toBe(sha256(FILE))
    }
    expect(updates.every((j) => j.retryCount === undefined)).toBe(true)
    expect(updates.some((j) => j.error?.startsWith('Retry'))).toBe(false)
    expect(server.log.filter((line) => line.startsWith('> 425')).length).toBeGreaterThanOrEqual(1)
    expect(pool.limit).toBe(2)
  }, 20_000)

  it('should retry a mid-session 421 on a lone connection and finish the file', async () => {
    // covers: Test-1197
    await setup({ reply421OnRetr: 1 })

    const { job, localPath } = await download()

    expect(updates.map((j) => j.error)).toContain(
      'Retry 1/3: 421 Service not available, closing control connection.'
    )
    expect(job.retryCount).toBe(1)
    expect(sha256(fs.readFileSync(localPath))).toBe(sha256(FILE))
    expect(server.log.filter((line) => line.startsWith('< RETR'))).toHaveLength(2)
  }, 20_000)

  it('should leave no partial local file after a download cut by a FIN on every attempt fails', async () => {
    // covers: Test-1187
    await setup({ finDuringRetr: 4 })
    const localPath = path.join(dir, 'file.bin')

    const job = await downloadUntilFailed(localPath)

    expect(job.retryCount).toBe(3)
    expect(server.log.filter((line) => line.startsWith('< RETR'))).toHaveLength(4)
    await vi.waitFor(() => expect(fs.existsSync(localPath)).toBe(false))
  }, 20_000)

  it('should leave no file after a failed GUI download that overwrote an existing file', async () => {
    // covers: Test-1187
    await setup({ finDuringRetr: 4 })
    const localPath = path.join(dir, 'file.bin')
    // 충돌 시트에서 덮어쓰기를 고른 기존 파일: 첫 시도가 'w'로 열며 이미 잘랐다
    fs.writeFileSync(localPath, 'existing file the user chose to overwrite')

    const job = await downloadUntilFailed(localPath)

    expect(job.retryCount).toBe(3)
    await vi.waitFor(() => expect(fs.existsSync(localPath)).toBe(false))
  }, 20_000)
})
