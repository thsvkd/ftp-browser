import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Client } from 'basic-ftp'
import { TransferQueue } from './TransferQueue'
import { TransferClientPool } from './TransferClientPool'
import { FtpFileOperations } from '../ftp/FtpFileOperations'
import { SegmentWriter } from '../ftp/segmentWriter'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import { startMockFtpServer, type MockFtpServer } from './__fixtures__/mockFtpServer'

// 디스크가 가득 차는 상황을 흉내 내려고 fs.writev를 갈아 끼울 수 있게 감싼다(ESM의 fs는 spyOn으로 바꿀 수 없다).
// hooks.writev가 없으면 실제 fs 그대로다.
type WritevCallback = (err: Error | null, bytes: number) => void
const hooks = vi.hoisted(() => ({
  writev: undefined as
    | undefined
    | ((position: number, write: () => void, callback: WritevCallback) => void)
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const writev = (...args: unknown[]): void => {
    const write = (): void => (actual.writev as (...a: unknown[]) => void)(...args)
    if (hooks.writev) {
      hooks.writev(args[2] as number, write, args[args.length - 1] as WritevCallback)
    } else write()
  }
  return { ...actual, writev }
})

const MiB = 1024 * 1024
const FILE_SIZE = 5 * MiB

// 64 MiB 기준을 1 MiB로 낮추고 구간 크기를 1.25 MiB로 잡아, 5 MiB 파일이 4구간으로 나뉘게 한다.
// 루프백의 SIZE 응답은 LAN 기준보다 빨라 한 스트림으로 받으므로, LAN 판정을 꺼 분할 경로를 본다.
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
    hooks.writev = undefined
    pool.dispose()
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('should download a 5 MiB file in 4 segments that hashes the same as the source', async () => {
    const queue = await setup(false)
    const createSocket = vi.spyOn(SegmentWriter.prototype, 'createSocket')
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
    // 평문 FTP의 구간은 데이터 소켓이 슬랩에 바로 읽어 넣는다
    expect(createSocket).toHaveBeenCalledTimes(4)
    createSocket.mockRestore()
  })

  it('should fall back to one stream and still match the source when the server ignores REST', async () => {
    const queue = await setup(true)
    const localPath = await download(queue)

    expect(sha256(fs.readFileSync(localPath))).toBe(sha256(source))
    expect(fs.statSync(localPath).size).toBe(FILE_SIZE)
    expect(pool.segmentedBroken).toBe(true)
    expect(queue.getAll()[0].retryCount).toBeUndefined()
  })

  it('should fail the job as disk full without retrying when a range write hits ENOSPC', async () => {
    // 희소 파일은 늘릴 때 공간을 잡아 두지 않아, 디스크가 차면 전송 중의 쓰기에서야 드러난다
    hooks.writev = (position, write, callback) => {
      if (position < FILE_SIZE / 2) return write()
      const err = Object.assign(new Error('ENOSPC: no space left on device, write'), {
        code: 'ENOSPC'
      })
      setImmediate(() => callback(err, 0))
    }
    const queue = await setup(false)
    const localPath = path.join(dir, 'big.bin')
    queue.enqueue('download', localPath, '/big.bin', 'big.bin', FILE_SIZE)
    await vi.waitFor(() => expect(queue.getAll()[0].status).toBe('failed'), {
      timeout: 15_000,
      interval: 20
    })

    const [job] = queue.getAll()
    // classifyError의 FS_DISK_FULL 메시지 그대로다. "Retry 1/3: ..."이 아니므로 재시도하지 않았다.
    expect(job.error).toBe('Disk is full.')
    expect(job.retryCount).toBeUndefined()
    // 미리 늘려 둔 파일은 남기지 않는다
    await vi.waitFor(() => expect(fs.existsSync(localPath)).toBe(false), { timeout: 5_000 })
    const retrs = server.log.filter((line) => line.startsWith('< RETR'))
    expect(retrs.length).toBeLessThanOrEqual(4)
  })

  it.runIf(process.platform === 'win32')(
    'should leave a sparse file that hashes the same as the source on Windows',
    async () => {
      const queue = await setup(false)
      const localPath = await download(queue)

      const koffi = await import('koffi')
      const getFileAttributes = koffi
        .load('kernel32.dll')
        .func('uint32_t __stdcall GetFileAttributesW(str16 path)')
      const INVALID_FILE_ATTRIBUTES = 0xffffffff
      const FILE_ATTRIBUTE_SPARSE_FILE = 0x200
      const attributes = getFileAttributes(localPath) as number
      expect(attributes).not.toBe(INVALID_FILE_ATTRIBUTES)
      expect(attributes & FILE_ATTRIBUTE_SPARSE_FILE).toBe(FILE_ATTRIBUTE_SPARSE_FILE)
      expect(sha256(fs.readFileSync(localPath))).toBe(sha256(source))
    }
  )
})
