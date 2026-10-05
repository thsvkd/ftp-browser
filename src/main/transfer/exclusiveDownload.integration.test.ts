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
import type { TransferJob } from '@shared/types/transfer'
import { startMockFtpServer, type MockFtpServer } from './__fixtures__/mockFtpServer'

const KiB = 1024
const MiB = 1024 * KiB
/** 분할 기준(아래 mock의 1 MiB)보다 작아 한 스트림(FtpFileOperations.download)으로 받는다 */
const SMALL = 256 * KiB
/** 분할 기준 이상이라 구간으로 나눠 받는다(4구간) */
const BIG = 5 * MiB

// 64 MiB 기준을 1 MiB로 낮추고, 루프백 SIZE가 LAN으로 보이지 않게 LAN 판정을 꺼 분할 경로를 탄다.
vi.mock('./segmentedDownload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./segmentedDownload')>()
  return {
    ...actual,
    SEGMENT_MIN: 1024 * 1024,
    LAN_RTT_MS: 0,
    planSegments: (size: number, limit: number) =>
      actual.planSegments(size, limit, 1024 * 1024, (5 * 1024 * 1024) / 4)
  }
})

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 엉뚱한 위치에 써지면 해시가 반드시 달라지는 의사 난수 내용 */
function content(size: number, seed: number): Buffer {
  const data = Buffer.alloc(size)
  let x = seed >>> 0
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    data[i] = x >>> 24
  }
  return data
}

describe('exclusive (agent) downloads against a mock FTP server', () => {
  const small = content(SMALL, 0x2468ace0)
  const big = content(BIG, 0x13579bdf)
  let server: MockFtpServer | undefined
  let pool: TransferClientPool | undefined
  let dir: string

  async function setup(file: Buffer, ignoreRest = false): Promise<TransferQueue> {
    const started = await startMockFtpServer({ file, ignoreRest })
    server = started
    const manager = {
      createSecondaryClient: async () => {
        const client = new Client(10_000)
        await client.access({ host: '127.0.0.1', port: started.port, user: 'u', password: 'p' })
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
  }

  function enqueue(queue: TransferQueue, name: string, size: number, exclusive: boolean): string {
    const localPath = path.join(dir, name)
    queue.enqueueBatch(
      'download',
      [{ localPath, remotePath: `/${name}`, fileName: name, totalBytes: size }],
      false,
      undefined,
      exclusive ? { exclusive: true } : undefined
    )
    return localPath
  }

  async function finished(queue: TransferQueue): Promise<TransferJob> {
    await vi.waitFor(() => expect(['completed', 'failed']).toContain(queue.getAll()[0].status), {
      timeout: 15_000,
      interval: 20
    })
    // 실패·취소 뒤의 정리(unlink)는 기다리지 않고 도므로, 남아 있을 정리가 끝날 틈을 준다
    await new Promise((r) => setTimeout(r, 100))
    return queue.getAll()[0]
  }

  function retrs(): string[] {
    return server!.log.filter((line) => line.startsWith('< RETR'))
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exdl-'))
  })

  async function teardown(): Promise<void> {
    pool?.dispose()
    await server?.close()
    pool = undefined
    server = undefined
  }

  afterEach(async () => {
    await teardown()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('fails a single-stream download whose target appeared after it was queued and leaves that file alone', async () => {
    // covers: Test-625
    const queue = await setup(small)
    const localPath = enqueue(queue, 'a.bin', SMALL, true)
    // 작업이 연결을 기다리는 사이 rename_local 같은 것이 같은 경로에 파일을 놓는다
    fs.writeFileSync(localPath, 'appeared meanwhile')

    const job = await finished(queue)

    expect(job.status).toBe('failed')
    expect(job.error).toBe('File already exists.')
    expect(job.retryCount).toBeUndefined()
    expect(fs.readFileSync(localPath, 'utf8')).toBe('appeared meanwhile')
    expect(retrs()).toEqual([])
  })

  it('fails a segmented download whose target appeared after it was queued and leaves that file alone', async () => {
    // covers: Test-626
    const queue = await setup(big)
    const localPath = enqueue(queue, 'big.bin', BIG, true)
    fs.writeFileSync(localPath, 'appeared meanwhile')

    const job = await finished(queue)

    expect(server!.log).toContain('< SIZE /big.bin')
    expect(job.status).toBe('failed')
    expect(job.error).toBe('File already exists.')
    expect(job.retryCount).toBeUndefined()
    expect(fs.readFileSync(localPath, 'utf8')).toBe('appeared meanwhile')
    expect(retrs()).toEqual([])
  })

  it('completes on both paths when the target stays free', async () => {
    // covers: Test-627
    for (const [file, name, segments] of [
      [small, 'a.bin', 1],
      [big, 'big.bin', 4]
    ] as const) {
      const queue = await setup(file)
      const localPath = enqueue(queue, name, file.length, true)

      const job = await finished(queue)

      expect(job.status).toBe('completed')
      expect(sha256(fs.readFileSync(localPath))).toBe(sha256(file))
      expect(retrs()).toHaveLength(segments)
      await teardown()
    }
  })

  it('re-runs one stream over the file it created itself when the server ignores REST', async () => {
    // covers: Test-628
    const queue = await setup(big, true)
    const localPath = enqueue(queue, 'big.bin', BIG, true)

    const job = await finished(queue)

    // 구간이 'wx'로 만든 파일을 한 스트림 재실행이 다시 열어 처음부터 받는다(이미 있다고 실패하지 않는다)
    expect(pool!.segmentedBroken).toBe(true)
    expect(job.status).toBe('completed')
    expect(job.error).toBeUndefined()
    expect(sha256(fs.readFileSync(localPath))).toBe(sha256(big))
  })

  it('still overwrites an existing target for a GUI download on both paths', async () => {
    // covers: Test-633
    for (const [file, name] of [
      [small, 'a.bin'],
      [big, 'big.bin']
    ] as const) {
      const queue = await setup(file)
      const localPath = enqueue(queue, name, file.length, false)
      fs.writeFileSync(localPath, 'the user chose to overwrite this')

      const job = await finished(queue)

      expect(job.status).toBe('completed')
      expect(sha256(fs.readFileSync(localPath))).toBe(sha256(file))
      await teardown()
    }
  })
})
