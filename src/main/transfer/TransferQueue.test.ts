import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { unlink } from 'fs/promises'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { Readable, type Writable } from 'stream'
import { pipeline } from 'stream/promises'
import { FTPError, type Client } from 'basic-ftp'
import { LOGIN_HOLD_MS, MAX_LOGIN_FAILURES, TransferQueue } from './TransferQueue'
import { planSegments, LAN_RTT_MS } from './segmentedDownload'
import {
  LIMIT,
  MAX_PROBE_COOLDOWN_MS,
  MAX_TRANSFER_CLIENTS,
  PROBE_COOLDOWN_MS,
  REFUSED_LOGIN_BACKOFF_MS,
  TransferClientPool
} from './TransferClientPool'
import { FtpFileOperations } from '../ftp/FtpFileOperations'
import { markSparse } from '../utils/sparseFile'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import type { TransferJob, TransferUpdate } from '@shared/types/transfer'

vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs/promises')>()),
  unlink: vi.fn().mockResolvedValue(undefined)
}))

// 테스트가 fastSuspects에 넣은 에러만 빠른 업로드 탓으로 본다. 진짜 판정은 fastTransfer.test.ts가 다룬다.
// 업로드는 받은 클라이언트의 uploadFrom으로 넘겨 어느 클라이언트로 갔는지만 본다(읽기는 fastTransfer.test.ts).
const { fastSuspects } = vi.hoisted(() => ({ fastSuspects: new WeakSet<object>() }))
vi.mock('../ftp/fastTransfer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ftp/fastTransfer')>()),
  fastUpload: (client: Client, localPath: string, remotePath: string) =>
    client.uploadFrom(localPath, remotePath),
  isFastFlowSuspect: (err: unknown) => err instanceof Error && fastSuspects.has(err)
}))

// 희소 표시는 Windows API를 부르므로 호출만 본다. 실제 동작은 sparseFile.test.ts와 Windows 통합 테스트가 다룬다.
vi.mock('../utils/sparseFile', () => ({ markSparse: vi.fn().mockResolvedValue(true) }))

// 분할 기준(64 MiB)을 4000바이트로, 구간 크기를 1000바이트로 낮춘다. 기존 테스트의 작업(최대 1024바이트)은
// 기준 아래라 그대로 한 스트림으로 돈다. LAN 한 스트림의 속도 판정은 20 ms 뒤에 한다.
const SEG_MIN = 4000
const PROBE = 20
vi.mock('./segmentedDownload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./segmentedDownload')>()
  return {
    ...actual,
    SEGMENT_MIN: 4000,
    PROBE_MS: 20,
    planSegments: vi.fn((size: number, limit: number, minSize = 4000) =>
      actual.planSegments(size, limit, minSize, 1000)
    )
  }
})

function createMockFileOps(): FtpFileOperations {
  return {
    upload: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    deleteDirectory: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined)
  } as unknown as FtpFileOperations
}

interface FakeClient {
  closed: boolean
  close: ReturnType<typeof vi.fn>
  sendIgnoringError: ReturnType<typeof vi.fn>
}

function createFakeClient(): FakeClient {
  const client: FakeClient = {
    closed: false,
    close: vi.fn(() => {
      client.closed = true
    }),
    // MKD 성공 응답. 음수 응답(이미 있음 등)은 테스트가 따로 준다.
    sendIgnoringError: vi.fn().mockResolvedValue({ code: 257, message: '257 created' })
  }
  return client
}

interface MockPool {
  limit: number
  segmentedBroken: boolean
  fastBroken: boolean
  clients: FakeClient[]
  acquire: ReturnType<typeof vi.fn<() => Promise<FakeClient | typeof LIMIT | null>>>
  release: ReturnType<typeof vi.fn>
  discard: ReturnType<typeof vi.fn>
  releaseAfterError: ReturnType<typeof vi.fn>
  armIdleClose: ReturnType<typeof vi.fn>
  /** acquire가 새로 로그인한 클라이언트를 줬는지. 기본값은 매번 새 로그인이다. */
  takeFreshLogin: ReturnType<typeof vi.fn>
  /** 큐가 함께 돌릴 수 있는 수. 시험 로그인을 하지 않는 mock이라 limit와 같다. */
  readonly slots: number
  probeDelay: ReturnType<typeof vi.fn>
  /** 메인 클라이언트 fallback에서 쓰는 브라우즈용 클라이언트 */
  main: FakeClient
  runOnMainClient: ReturnType<typeof vi.fn>
}

/** 매 acquire마다 새 가짜 클라이언트를 주는 풀. limit와 acquire 결과는 테스트가 바꾼다. */
function createMockPool(limit = 3): MockPool {
  const clients: FakeClient[] = []
  const main = createFakeClient()
  return {
    limit,
    segmentedBroken: false,
    fastBroken: false,
    clients,
    acquire: vi.fn(async (): Promise<FakeClient | typeof LIMIT | null> => {
      const client = createFakeClient()
      clients.push(client)
      return client
    }),
    release: vi.fn(),
    discard: vi.fn(),
    releaseAfterError: vi.fn(),
    armIdleClose: vi.fn(),
    takeFreshLogin: vi.fn(() => true),
    get slots() {
      return this.limit
    },
    probeDelay: vi.fn(() => Infinity),
    main,
    runOnMainClient: vi.fn((task: (client: FakeClient) => Promise<unknown>) => task(main))
  }
}

function asPool(pool: MockPool): TransferClientPool {
  return pool as unknown as TransferClientPool
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (err: unknown) => void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 원격 경로별로 끝나지 않는 전송을 만들고, 테스트가 골라서 끝낸다. */
function deferTransfers(fn: unknown): Map<string, Deferred> {
  const pending = new Map<string, Deferred>()
  ;(fn as ReturnType<typeof vi.fn>).mockImplementation((a: string, b: string) => {
    const d = deferred()
    // download(remote, local) / upload(local, remote) 모두 원격 경로로 찾는다
    pending.set(a.startsWith('/remote') ? a : b, d)
    return d.promise
  })
  return pending
}

function items(n: number, prefix = ''): Parameters<TransferQueue['enqueueBatch']>[1] {
  return Array.from({ length: n }, (_, i) => ({
    localPath: `/local/${prefix}${i}.jpg`,
    remotePath: `/remote/${prefix}${i}.jpg`,
    fileName: `${prefix}${i}.jpg`,
    totalBytes: 10
  }))
}

const MKD_OK = { code: 257, message: '257 created' }

/** 보조 연결의 connect가 거부된 형태. net이 붙이는 code·syscall·address·port를 모두 갖는다. */
function refusedError(): Error {
  return Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:2121 (control socket)'), {
    code: 'ECONNREFUSED',
    syscall: 'connect',
    address: '127.0.0.1',
    port: 2121
  })
}

/** 로그인 실패 뒤 큐를 쉬게 하는 시간의 합. 이만큼 지나면 큐가 남은 작업을 한꺼번에 실패시킨다. */
const LOGIN_HOLD_TOTAL = Array.from(
  { length: MAX_LOGIN_FAILURES - 1 },
  (_, i) => LOGIN_HOLD_MS * 2 ** i
).reduce((a, b) => a + b, 0)

/** 마이크로태스크만 흘려보낸다(재시도 타이머는 건드리지 않음). */
const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => undefined)

describe('TransferQueue', () => {
  let queue: TransferQueue
  let mockFileOps: FtpFileOperations
  let pool: MockPool

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockFileOps = createMockFileOps()
    pool = createMockPool()
    queue = new TransferQueue(mockFileOps, asPool(pool))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('enqueue', () => {
    it('should add a job and return an id', () => {
      const id = queue.enqueue('download', '/local/file.jpg', '/remote/file.jpg', 'file.jpg', 1024)
      expect(id).toBeTruthy()
      expect(typeof id).toBe('string')
    })

    it('should emit queue:updated when a job is added', async () => {
      const listener = vi.fn()
      queue.on('queue:updated', listener)

      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)

      // 변경은 FLUSH_MS 단위로 모아서 내보내므로 타이머를 넘기기 전에는 emit이 없다.
      expect(listener).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(100)

      // 빈 큐의 첫 active와 큐가 비는 순간(완료)은 주기를 기다리지 않고 바로 나간다
      expect(listener).toHaveBeenCalledTimes(2)
      const update = listener.mock.calls[0][0] as TransferUpdate
      expect(update.removedIds).toEqual([])
      expect(update.upserts).toHaveLength(1)
      expect(update.upserts[0].fileName).toBe('a.jpg')
    })

    it('should report the state of the job at flush time, not at enqueue time', async () => {
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {})
      )
      const listener = vi.fn()
      queue.on('queue:updated', listener)

      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)
      await vi.advanceTimersByTimeAsync(100)

      const update = listener.mock.calls[0][0] as TransferUpdate
      expect(update.upserts[0].status).toBe('active') // 곧바로 처리가 시작된다
    })

    it('should generate unique ids for each job', () => {
      const id1 = queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)
      const id2 = queue.enqueue('upload', '/local/b.jpg', '/remote/b.jpg', 'b.jpg', 200)
      expect(id1).not.toBe(id2)
    })

    it('should enqueue a multi-file transfer as one batch', async () => {
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {})
      )

      const ids = queue.enqueueBatch('download', [
        {
          localPath: '/local/a.jpg',
          remotePath: '/remote/a.jpg',
          fileName: 'a.jpg',
          totalBytes: 100
        },
        {
          localPath: '/local/b.jpg',
          remotePath: '/remote/b.jpg',
          fileName: 'b.jpg',
          totalBytes: 200
        }
      ])

      const jobs = queue.getAll()
      expect(ids).toHaveLength(2)
      expect(jobs).toHaveLength(2)
      expect(jobs[0].batchId).toBeTruthy()
      expect(jobs[1].batchId).toBe(jobs[0].batchId)
      await settle()
      // 풀 슬롯이 남으므로 같은 배치의 파일이 함께 전송된다
      expect(queue.getAll().map((job) => job.status)).toEqual(['active', 'active'])
    })

    it('should keep a one-file folder transfer grouped when forced', () => {
      ;(mockFileOps.upload as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {})
      )

      queue.enqueueBatch(
        'upload',
        [
          {
            localPath: '/local/folder/only.jpg',
            remotePath: '/remote/folder/only.jpg',
            fileName: 'only.jpg',
            totalBytes: 100
          }
        ],
        true
      )

      expect(queue.getAll()[0].batchId).toBeTruthy()
    })
  })

  describe('getAll', () => {
    it('should return a copy of the queue', () => {
      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)
      const all = queue.getAll()
      expect(all).toHaveLength(1)
      // Should be a copy, not a reference
      all.pop()
      expect(queue.getAll()).toHaveLength(1)
    })

    it('should return empty array when no jobs', () => {
      expect(queue.getAll()).toEqual([])
    })
  })

  describe('cancel', () => {
    it('should cancel a pending job', async () => {
      pool.limit = 1
      // Make the first job hang so subsequent jobs stay pending
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {})
      )

      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100) // starts immediately
      const id2 = queue.enqueue('download', '/local/b.jpg', '/remote/b.jpg', 'b.jpg', 200)
      await settle()

      queue.cancel(id2)

      const jobs = queue.getAll()
      const job2 = jobs.find((j) => j.id === id2)
      expect(job2?.status).toBe('cancelled')
      expect(mockFileOps.download).toHaveBeenCalledTimes(1)
    })

    it('should cancel an active job by closing its client, without retrying it', async () => {
      const download = mockFileOps.download as ReturnType<typeof vi.fn>
      download.mockImplementation(
        (_remote: string, _local: string, _onProgress: unknown, client: FakeClient) =>
          new Promise((_, reject) => {
            // 소켓이 닫히면 basic-ftp는 재시도 대상 에러로 끝난다
            client.close.mockImplementation(() => {
              client.closed = true
              reject(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }))
            })
          })
      )

      const id = queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)
      await settle()
      expect(queue.getAll()[0].status).toBe('active')

      queue.cancel(id)
      await vi.advanceTimersByTimeAsync(5000)

      const [client] = pool.clients
      expect(client.close).toHaveBeenCalled()
      expect(queue.getAll()[0].status).toBe('cancelled')
      expect(queue.getAll()[0].retryCount).toBeUndefined()
      expect(download).toHaveBeenCalledTimes(1)
      expect(pool.discard).toHaveBeenCalledWith(client)
      expect(pool.release).not.toHaveBeenCalled()
      expect(pool.releaseAfterError).not.toHaveBeenCalled()
      // 받다 만 로컬 파일은 지운다
      expect(unlink).toHaveBeenCalledWith('/local/a.jpg')
    })

    it('should leave the remote partial file of a cancelled upload alone', async () => {
      ;(mockFileOps.upload as ReturnType<typeof vi.fn>).mockImplementation(
        (_local: string, _remote: string, _onProgress: unknown, client: FakeClient) =>
          new Promise((_, reject) => {
            client.close.mockImplementation(() => reject(new Error('closed')))
          })
      )

      const id = queue.enqueue('upload', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)
      await settle()
      queue.cancel(id)
      await settle()

      expect(queue.getAll()[0].status).toBe('cancelled')
      expect(unlink).not.toHaveBeenCalled()
      expect(mockFileOps.deleteFile).not.toHaveBeenCalled()
    })

    it('should not start a job that was cancelled while its client was connecting', async () => {
      const gate = deferred()
      const client = createFakeClient()
      pool.acquire.mockImplementationOnce(async () => {
        await gate.promise
        return client
      })

      const id = queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)
      queue.cancel(id)
      gate.resolve()
      await settle()

      expect(queue.getAll()[0].status).toBe('cancelled')
      expect(mockFileOps.download).not.toHaveBeenCalled()
      // 쓰지 않은 클라이언트는 멀쩡하므로 풀에 돌려준다
      expect(pool.release).toHaveBeenCalledWith(client)
    })

    it.each([
      ['a retryable', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })],
      ['a non-retryable', new Error('Not connected')]
    ])(
      'should keep a job cancelled while its client was logging in when the login fails with %s error',
      async (_label, loginError) => {
        const gate = deferred()
        pool.acquire.mockImplementationOnce(async () => {
          await gate.promise
          throw loginError
        })

        const id = queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)
        await settle()
        queue.cancel(id)
        gate.resolve()
        await settle()
        await vi.advanceTimersByTimeAsync(5000)

        // 취소된 작업이 재시도로 되살아나거나 실패로 바뀌면 안 된다
        expect(queue.getAll()[0].status).toBe('cancelled')
        expect(queue.getAll()[0].retryCount).toBeUndefined()
        expect(mockFileOps.download).not.toHaveBeenCalled()
      }
    )

    it('should not cancel an active job running on the main client (fallback)', async () => {
      pool.limit = 1
      pool.acquire.mockResolvedValue(null)
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {})
      )

      const id = queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)
      await settle()

      // 메인 클라이언트를 닫으면 연결 끊김으로 보이므로 지금처럼 무시한다
      queue.cancel(id)

      expect(queue.getAll()[0].status).toBe('active')
    })
  })

  describe('clearCompleted', () => {
    it('should remove completed, failed, and cancelled jobs', async () => {
      // First job completes immediately
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)

      // Wait for processing
      await vi.waitFor(() => {
        const jobs = queue.getAll()
        expect(jobs.some((j) => j.status === 'completed')).toBe(true)
      })

      queue.clearCompleted()
      const remaining = queue.getAll()
      expect(remaining.filter((j) => j.status === 'completed')).toHaveLength(0)
    })

    it('should retain completed files that contribute to an active batch total', async () => {
      let resolveFirst: (() => void) | undefined
      ;(mockFileOps.download as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveFirst = resolve
            })
        )
        .mockImplementationOnce(() => new Promise(() => {}))

      queue.enqueueBatch('download', [
        {
          localPath: '/local/a.jpg',
          remotePath: '/remote/a.jpg',
          fileName: 'a.jpg',
          totalBytes: 100
        },
        {
          localPath: '/local/b.jpg',
          remotePath: '/remote/b.jpg',
          fileName: 'b.jpg',
          totalBytes: 200
        }
      ])
      await settle()
      resolveFirst?.()

      await vi.waitFor(() => {
        expect(queue.getAll().map((job) => job.status)).toEqual(['completed', 'active'])
      })

      queue.clearCompleted()

      expect(queue.getAll()).toHaveLength(2)
    })
  })

  describe('scheduling', () => {
    it('should call download for download jobs on a pool client', async () => {
      queue.enqueue('download', '/local/file.jpg', '/remote/file.jpg', 'file.jpg', 1024)

      await vi.waitFor(() => {
        expect(mockFileOps.download).toHaveBeenCalledWith(
          '/remote/file.jpg',
          '/local/file.jpg',
          expect.any(Function),
          pool.clients[0]
        )
      })
      expect(pool.release).toHaveBeenCalledWith(pool.clients[0])
    })

    it('should call upload for upload jobs on a pool client', async () => {
      queue.enqueue('upload', '/local/file.jpg', '/remote/file.jpg', 'file.jpg', 1024)

      await vi.waitFor(() => {
        expect(mockFileOps.upload).toHaveBeenCalledWith(
          '/local/file.jpg',
          '/remote/file.jpg',
          expect.any(Function),
          pool.clients[0],
          true
        )
      })
    })

    it('should mark job as completed on success', async () => {
      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)

      await vi.waitFor(() => {
        const jobs = queue.getAll()
        expect(jobs[0].status).toBe('completed')
        expect(jobs[0].transferredBytes).toBe(100)
      })
    })

    it('should mark job as failed on error', async () => {
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Network error')
      )

      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)

      await vi.waitFor(() => {
        const jobs = queue.getAll()
        expect(jobs[0].status).toBe('failed')
        expect(jobs[0].error).toBe('Network error')
      })
    })

    it('should respect pool.limit and start the next job when one finishes', async () => {
      const transfers = deferTransfers(mockFileOps.download)

      queue.enqueueBatch('download', items(4))
      await settle()

      expect(queue.getAll().map((job) => job.status)).toEqual([
        'active',
        'active',
        'active',
        'pending'
      ])
      expect(mockFileOps.download).toHaveBeenCalledTimes(3)

      transfers.get('/remote/1.jpg')!.resolve()
      await settle()

      expect(queue.getAll().map((job) => job.status)).toEqual([
        'active',
        'completed',
        'active',
        'active'
      ])
      expect(mockFileOps.download).toHaveBeenCalledTimes(4)
      // 풀 계약: running을 줄이기 전에 release한다
      expect(pool.release).toHaveBeenCalledTimes(1)
    })

    it('should put an item back at the head when the pool signals LIMIT', async () => {
      const transfers = deferTransfers(mockFileOps.download)
      pool.acquire
        .mockImplementationOnce(async () => createFakeClient())
        .mockImplementationOnce(async () => createFakeClient())
        .mockImplementationOnce(async () => {
          // 서버가 세 번째 로그인을 421로 거부했다
          pool.limit = 2
          return LIMIT
        })

      queue.enqueueBatch('download', items(4))
      await settle()

      // 실패가 아니라 대기로 남고, 동시 전송은 줄어든 limit를 넘지 않는다
      expect(queue.getAll().map((job) => job.status)).toEqual([
        'active',
        'active',
        'pending',
        'pending'
      ])
      expect(queue.getAll()[2].error).toBeUndefined()
      expect(mockFileOps.download).toHaveBeenCalledTimes(2)

      transfers.get('/remote/0.jpg')!.resolve()
      await settle()

      // 되돌린 항목(2)이 뒤의 항목(3)보다 먼저 시작한다
      expect(mockFileOps.download).toHaveBeenCalledTimes(3)
      expect((mockFileOps.download as ReturnType<typeof vi.fn>).mock.calls[2][0]).toBe(
        '/remote/2.jpg'
      )
      expect(queue.getAll()[3].status).toBe('pending')
    })

    it('should run jobs one at a time on the main client when the pool returns null', async () => {
      pool.acquire.mockImplementation(async () => {
        // 보조 로그인이 전혀 안 되는 서버: 풀은 limit를 1로 줄이고 null을 준다
        pool.limit = 1
        return null
      })
      const transfers = deferTransfers(mockFileOps.upload)

      queue.enqueueBatch('upload', items(3))
      await settle()

      const upload = mockFileOps.upload as ReturnType<typeof vi.fn>
      expect(upload).toHaveBeenCalledTimes(1)
      // client 없이 부르면 FtpFileOperations가 runOnMainClient로 실행한다
      expect(upload.mock.calls[0][3]).toBeUndefined()

      transfers.get('/remote/0.jpg')!.resolve()
      await settle()

      expect(upload).toHaveBeenCalledTimes(2)
      expect(queue.getAll().map((job) => job.status)).toEqual(['completed', 'active', 'pending'])
      expect(pool.release).not.toHaveBeenCalled()
    })

    it('should fail the job when the pool cannot log in', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      pool.acquire.mockRejectedValue(new Error('Not connected'))

      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)
      await settle()
      // 한 번의 로그인 실패로 작업을 실패시키지 않는다
      expect(queue.getAll()[0].status).toBe('pending')

      await vi.advanceTimersByTimeAsync(LOGIN_HOLD_TOTAL)
      expect(queue.getAll()[0].status).toBe('failed')
      expect(queue.getAll()[0].error).toBe('Not connected to FTP server.')
      expect(mockFileOps.download).not.toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe('pool login failures', () => {
    const loginIncorrect = (): FTPError =>
      new FTPError({ code: 530, message: '530 Login incorrect' })

    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.mocked(console.warn).mockRestore()
    })

    it('should hold the queue instead of failing each job while logins keep failing', async () => {
      pool.acquire.mockRejectedValue(loginIncorrect())

      queue.enqueueBatch('download', items(500))
      await settle()
      // 함께 시작한 로그인(limit개)이 함께 실패해도 작업은 하나도 실패하지 않는다
      expect(pool.acquire).toHaveBeenCalledTimes(3)
      expect(queue.getAll().every((job) => job.status === 'pending')).toBe(true)

      await vi.advanceTimersByTimeAsync(LOGIN_HOLD_MS - 1)
      expect(pool.acquire).toHaveBeenCalledTimes(3)
      // 쉬고 나면 로그인을 하나만 다시 시도한다
      await vi.advanceTimersByTimeAsync(1)
      expect(pool.acquire).toHaveBeenCalledTimes(4)
      expect(queue.getAll().every((job) => job.status === 'pending')).toBe(true)
    })

    it('should fail the remaining jobs with one error after a bounded number of logins', async () => {
      pool.acquire.mockRejectedValue(loginIncorrect())

      queue.enqueueBatch('download', items(500))
      await vi.advanceTimersByTimeAsync(LOGIN_HOLD_TOTAL)

      // 함께 실패한 첫 회차(limit개) 뒤로는 회차마다 한 번씩만 로그인한다
      expect(pool.acquire).toHaveBeenCalledTimes(3 + MAX_LOGIN_FAILURES - 1)
      const jobs = queue.getAll()
      expect(jobs.every((job) => job.status === 'failed')).toBe(true)
      expect(new Set(jobs.map((job) => job.error))).toEqual(
        new Set(['Authentication failed. Check username and password.'])
      )
      expect(jobs.every((job) => job.retryCount === undefined)).toBe(true)
      expect(mockFileOps.download).not.toHaveBeenCalled()
      expect(pool.armIdleClose).toHaveBeenCalled()

      // 실패시킨 뒤에는 다시 로그인하지 않는다
      await vi.advanceTimersByTimeAsync(60_000)
      expect(pool.acquire).toHaveBeenCalledTimes(3 + MAX_LOGIN_FAILURES - 1)
    })

    it('should resume every job without charging it once a login succeeds', async () => {
      // 함께 시작한 로그인(limit개)이 모두 실패해야 큐가 쉰다
      for (let i = 0; i < 3; i++) pool.acquire.mockRejectedValueOnce(new Error('Not connected'))

      queue.enqueueBatch('download', items(5))
      await settle()
      expect(queue.getAll().every((job) => job.status === 'pending')).toBe(true)

      await vi.advanceTimersByTimeAsync(LOGIN_HOLD_MS)
      const jobs = queue.getAll()
      expect(jobs.map((job) => job.status)).toEqual(Array(5).fill('completed'))
      expect(jobs.every((job) => job.retryCount === undefined && !job.error)).toBe(true)
    })

    it('should start the other jobs as soon as a login succeeds after a failed round', async () => {
      const transfers = deferTransfers(mockFileOps.download)
      pool.acquire
        .mockRejectedValueOnce(loginIncorrect())
        .mockRejectedValueOnce(loginIncorrect())
        .mockRejectedValueOnce(loginIncorrect())

      queue.enqueueBatch('download', items(10))
      await vi.advanceTimersByTimeAsync(LOGIN_HOLD_MS)

      // 첫 작업이 끝날 때까지 한 연결로만 돌지 않는다
      expect(transfers.size).toBe(3)
      expect(pool.acquire).toHaveBeenCalledTimes(6)
    })

    it('should drop the hold when another login of the same round succeeds', async () => {
      const transfers = deferTransfers(mockFileOps.download)
      pool.acquire.mockRejectedValueOnce(loginIncorrect())

      queue.enqueueBatch('download', items(10))
      await settle()

      // 성공한 로그인이 있으면 빈 슬롯을 LOGIN_HOLD_MS 동안 비워 두지 않는다
      expect(transfers.size).toBe(3)
    })

    it('should keep holding when the other acquires of the round only reuse idle clients', async () => {
      const transfers = deferTransfers(mockFileOps.download)
      pool.acquire.mockRejectedValueOnce(loginIncorrect())
      pool.takeFreshLogin.mockReturnValue(false)

      queue.enqueueBatch('download', items(10))
      await settle()

      // idle 재사용은 로그인이 된다는 뜻이 아니다: 쉬는 동안 빈 슬롯으로 로그인을 다시 몰지 않는다
      expect(transfers.size).toBe(2)
      expect(pool.acquire).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(LOGIN_HOLD_MS)
      expect(pool.acquire).toHaveBeenCalledTimes(4)
      expect(transfers.size).toBe(3)
    })

    it('should hold only the first delay again after a login has succeeded', async () => {
      pool.limit = 1
      pool.acquire.mockRejectedValueOnce(loginIncorrect())
      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 10)
      await vi.advanceTimersByTimeAsync(LOGIN_HOLD_MS)
      expect(queue.getAll()[0].status).toBe('completed')

      pool.acquire.mockRejectedValueOnce(loginIncorrect())
      queue.enqueue('download', '/local/b.jpg', '/remote/b.jpg', 'b.jpg', 10)
      await vi.advanceTimersByTimeAsync(LOGIN_HOLD_MS)
      expect(queue.getAll()[1].status).toBe('completed')
    })

    it('should drop a job cancelled while the queue holds', async () => {
      pool.acquire.mockRejectedValueOnce(loginIncorrect())
      const id = queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 10)
      await settle()
      queue.cancel(id)

      await vi.advanceTimersByTimeAsync(LOGIN_HOLD_TOTAL)
      expect(queue.getAll()[0].status).toBe('cancelled')
      expect(pool.acquire).toHaveBeenCalledTimes(1)
      expect(pool.armIdleClose).toHaveBeenCalled()
    })

    it('should keep the socket address of a refused connection in the job error', async () => {
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockRejectedValueOnce(refusedError())

      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 10)
      await settle()

      expect(queue.getAll()[0].status).toBe('failed')
      expect(queue.getAll()[0].error).toBe(
        'Connection refused. Check the host and port. (ECONNREFUSED connect 127.0.0.1:2121)'
      )
    })
  })

  describe('retry', () => {
    it('should requeue a retryable error after RETRY_DELAY_MS while other jobs keep running', async () => {
      const download = mockFileOps.download as ReturnType<typeof vi.fn>
      const transfers = deferTransfers(download)
      const reset = Object.assign(new Error('reset'), { code: 'ECONNRESET' })

      queue.enqueueBatch('download', items(4))
      await settle()
      transfers.get('/remote/0.jpg')!.reject(reset)
      await settle()

      const first = queue.getAll()[0]
      expect(first.status).toBe('pending')
      expect(first.retryCount).toBe(1)
      expect(first.error).toMatch(/^Retry 1\/3/)
      expect(pool.releaseAfterError).toHaveBeenCalledWith(pool.clients[0], reset)
      // 큐가 2초 동안 막히지 않고 빈 슬롯에 다음 작업이 들어간다
      expect(queue.getAll()[3].status).toBe('active')
      expect(download).toHaveBeenCalledTimes(4)

      transfers.get('/remote/1.jpg')!.resolve()
      await vi.advanceTimersByTimeAsync(1999)
      expect(download).toHaveBeenCalledTimes(4)

      await vi.advanceTimersByTimeAsync(1)
      expect(download).toHaveBeenCalledTimes(5)
      expect(download.mock.calls[4][0]).toBe('/remote/0.jpg')
      expect(queue.getAll()[0].status).toBe('active')
    })

    it('should fail after MAX_RETRIES retryable errors', async () => {
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('reset'), { code: 'ECONNRESET' })
      )

      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)
      await vi.advanceTimersByTimeAsync(10_000)

      expect(mockFileOps.download).toHaveBeenCalledTimes(4)
      expect(queue.getAll()[0].status).toBe('failed')
    })
  })

  describe('fast upload fallback', () => {
    function fastSuspect(): Error {
      const err = new Error("Can't open data connection in passive mode: connect ECONNREFUSED")
      fastSuspects.add(err)
      return err
    }

    function fastFlags(): unknown[] {
      return (mockFileOps.upload as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[4])
    }

    it('should ask for the fast flow on pool clients until the pool marks it broken', async () => {
      queue.enqueue('upload', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 10)
      await settle()
      pool.fastBroken = true
      queue.enqueue('upload', '/local/b.jpg', '/remote/b.jpg', 'b.jpg', 10)
      await settle()

      expect(fastFlags()).toEqual([true, false])
    })

    it('should keep the standard path on the main-client fallback', async () => {
      pool.acquire.mockResolvedValue(null)
      queue.enqueue('upload', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 10)
      await settle()

      expect(mockFileOps.upload).toHaveBeenCalledWith(
        '/local/a.jpg',
        '/remote/a.jpg',
        expect.any(Function),
        undefined,
        false
      )
    })

    it('should retry a fast-flow failure at once through the standard path without using a retry', async () => {
      pool.limit = 1
      const upload = mockFileOps.upload as ReturnType<typeof vi.fn>
      upload.mockRejectedValueOnce(fastSuspect())

      queue.enqueueBatch('upload', items(3))
      // RETRY_DELAY_MS를 기다리지 않는다: 타이머를 진행하지 않아도 끝난다
      await settle()

      expect(upload.mock.calls.map((call) => [call[1], call[4]])).toEqual([
        ['/remote/0.jpg', true],
        // 맨 앞에 다시 넣어 뒤 작업보다 먼저, 표준 경로로 다시 보낸다
        ['/remote/0.jpg', false],
        ['/remote/1.jpg', false],
        ['/remote/2.jpg', false]
      ])
      expect(pool.fastBroken).toBe(true)
      expect(pool.discard).toHaveBeenCalledWith(pool.clients[0])
      expect(pool.releaseAfterError).not.toHaveBeenCalled()
      const first = queue.getAll()[0]
      expect(first.status).toBe('completed')
      expect(first.retryCount).toBeUndefined()
      expect(first.error).toBeUndefined()
    })

    it('should count a failure on the standard path against the retries as usual', async () => {
      pool.fastBroken = true
      const reset = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
      ;(mockFileOps.upload as ReturnType<typeof vi.fn>).mockRejectedValueOnce(reset)

      queue.enqueue('upload', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 10)
      await settle()

      expect(queue.getAll()[0].retryCount).toBe(1)
      expect(queue.getAll()[0].error).toMatch(/^Retry 1\/3/)
      expect(pool.releaseAfterError).toHaveBeenCalledWith(pool.clients[0], reset)
    })

    it('should keep the fast flow after an ordinary transfer error on it', async () => {
      // 1xx 뒤의 reset 같은 에러는 isFastFlowSuspect가 아니다: 평소대로 재시도하고 빠른 경로를 끄지 않는다
      const reset = Object.assign(new Error('read ECONNRESET (data socket)'), {
        code: 'ECONNRESET'
      })
      ;(mockFileOps.upload as ReturnType<typeof vi.fn>).mockRejectedValueOnce(reset)

      queue.enqueue('upload', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 10)
      await settle()
      await vi.advanceTimersByTimeAsync(2000)

      expect(fastFlags()).toEqual([true, true])
      expect(pool.fastBroken).toBe(false)
      expect(pool.releaseAfterError).toHaveBeenCalledWith(pool.clients[0], reset)
      expect(queue.getAll()[0].status).toBe('completed')
      expect(queue.getAll()[0].retryCount).toBe(1)
    })

    it('should not retry a cancelled upload whose closed client failed the fast flow', async () => {
      const upload = mockFileOps.upload as ReturnType<typeof vi.fn>
      const transfers = deferTransfers(upload)
      const id = queue.enqueue('upload', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 10)
      await settle()

      queue.cancel(id)
      transfers.get('/remote/a.jpg')!.reject(fastSuspect())
      await settle()

      expect(queue.getAll()[0].status).toBe('cancelled')
      expect(upload).toHaveBeenCalledTimes(1)
      expect(pool.fastBroken).toBe(false)
    })
  })

  describe('pool lifecycle', () => {
    it('should arm the idle close only when nothing is running or waiting to retry', async () => {
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        Object.assign(new Error('reset'), { code: 'ECONNRESET' })
      )

      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)
      await settle()
      expect(pool.armIdleClose).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2000)

      expect(queue.getAll()[0].status).toBe('completed')
      expect(pool.armIdleClose).toHaveBeenCalled()
    })
  })

  describe('with the real client pool', () => {
    function createRealPool(): {
      pool: TransferClientPool
      createSecondaryClient: ReturnType<typeof vi.fn>
      manager: Record<string, ReturnType<typeof vi.fn>>
    } {
      const createSecondaryClient = vi.fn(async () => {
        const client = createFakeClient()
        return Object.assign(client, {
          ftp: { socket: {}, _newSocket: () => new net.Socket() },
          trackProgress: vi.fn(),
          uploadFrom: vi.fn().mockResolvedValue({}),
          downloadTo: vi.fn().mockResolvedValue({})
        })
      })
      const manager = {
        createSecondaryClient,
        getMaxTransfers: vi.fn(() => 16),
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn(),
        runOnMainClient: vi.fn()
      }
      const realPool = new TransferClientPool(manager as unknown as FtpConnectionManager)
      return { pool: realPool, createSecondaryClient, manager }
    }

    it('should reuse the client after an FTPError 550 and discard it after a socket error', async () => {
      const { pool: realPool, createSecondaryClient } = createRealPool()
      const download = mockFileOps.download as ReturnType<typeof vi.fn>
      download
        .mockRejectedValueOnce(new FTPError({ code: 550, message: '550 No such file' }))
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Server sent FIN packet unexpectedly'))
        .mockResolvedValueOnce(undefined)
      queue = new TransferQueue(mockFileOps, realPool)

      for (const i of [0, 1, 2, 3]) {
        queue.enqueue('download', `/local/${i}`, `/remote/${i}`, `${i}`, 1)
        await settle()
      }

      const clients = await Promise.all(
        createSecondaryClient.mock.results.map((r) => r.value as Promise<FakeClient>)
      )
      // 550 뒤에는 같은 세션을 이어 쓰고, 소켓 에러 뒤에는 닫고 새로 로그인한다
      expect(download.mock.calls.map((call) => call[3])).toEqual([
        clients[0],
        clients[0],
        clients[0],
        clients[1]
      ])
      expect(clients[0].close).toHaveBeenCalled()
      expect(clients[1].close).not.toHaveBeenCalled()
      expect(queue.getAll().map((job) => job.status)).toEqual([
        'failed',
        'completed',
        'failed',
        'completed'
      ])
    })

    it('should never go through the main client while the pool hands out clients', async () => {
      const { pool: realPool, manager, createSecondaryClient } = createRealPool()
      const fileOps = new FtpFileOperations(manager as unknown as FtpConnectionManager)
      queue = new TransferQueue(fileOps, realPool)
      // 실제 fileOps의 다운로드는 로컬 파일을 직접 연다. 올릴 파일은 비워 둔다.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-real-'))
      const local = (list: ReturnType<typeof items>): ReturnType<typeof items> =>
        list.map((item) => ({ ...item, localPath: path.join(dir, item.fileName) }))
      const uploads = local(items(12, 'u'))
      for (const item of uploads) fs.writeFileSync(item.localPath, '')

      queue.enqueueBatch('upload', uploads)
      queue.enqueueBatch('download', local(items(12, 'd')))
      await vi.waitFor(() =>
        expect(queue.getAll().every((job) => job.status === 'completed')).toBe(true)
      )
      fs.rmSync(dir, { recursive: true, force: true })

      expect(manager.runOnMainClient).not.toHaveBeenCalled()
      expect(createSecondaryClient.mock.calls.length).toBeLessThanOrEqual(MAX_TRANSFER_CLIENTS)
      const clients = (await Promise.all(
        createSecondaryClient.mock.results.map((r) => r.value)
      )) as unknown as Array<Record<string, ReturnType<typeof vi.fn>>>
      const uploaded = clients.reduce((n, c) => n + c.uploadFrom.mock.calls.length, 0)
      const downloaded = clients.reduce((n, c) => n + c.downloadTo.mock.calls.length, 0)
      expect(uploaded).toBe(12)
      expect(downloaded).toBe(12)
    })

    describe('with refused logins', () => {
      beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
      })

      afterEach(() => {
        vi.mocked(console.warn).mockRestore()
      })

      it('should complete all 500 jobs when the first 20 logins are refused', async () => {
        const { pool: realPool, createSecondaryClient } = createRealPool()
        for (let i = 0; i < 20; i++) createSecondaryClient.mockRejectedValueOnce(refusedError())
        queue = new TransferQueue(mockFileOps, realPool)

        queue.enqueueBatch('download', items(500))
        await vi.advanceTimersByTimeAsync(10_000)

        const jobs = queue.getAll()
        expect(jobs.filter((job) => job.status !== 'completed')).toEqual([])
        expect(jobs.every((job) => job.retryCount === undefined)).toBe(true)
        expect(mockFileOps.download).toHaveBeenCalledTimes(500)
        realPool.dispose()
      })

      it('should run in parallel again after a whole burst of logins is refused', async () => {
        const { pool: realPool, createSecondaryClient } = createRealPool()
        for (let i = 0; i < 16; i++) createSecondaryClient.mockRejectedValueOnce(refusedError())
        let inFlight = 0
        let peak = 0
        ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          inFlight++
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 50))
          inFlight--
        })
        queue = new TransferQueue(mockFileOps, realPool)

        queue.enqueueBatch('download', items(200))
        await vi.advanceTimersByTimeAsync(20_000)

        // 함께 거부된 로그인이 서로를 세어 limit를 1까지 줄이면 남은 큐가 한 연결로만 돈다
        expect(queue.getAll().every((job) => job.status === 'completed')).toBe(true)
        expect(realPool.limit).toBe(16)
        expect(peak).toBe(16)
        realPool.dispose()
      })

      it('should run in parallel as soon as logins succeed again, not after the first long job', async () => {
        const { pool: realPool, createSecondaryClient } = createRealPool()
        for (let i = 0; i < 16; i++) createSecondaryClient.mockRejectedValueOnce(refusedError())
        let inFlight = 0
        ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          inFlight++
          await new Promise((resolve) => setTimeout(resolve, 60_000))
          inFlight--
        })
        queue = new TransferQueue(mockFileOps, realPool)

        queue.enqueueBatch('download', items(40))
        await vi.advanceTimersByTimeAsync(1_000)

        // 거부된 15개는 LIMIT로 큐에 돌아갔다. 쉬었다 다시 된 로그인이 나머지 슬롯을 바로 채워야 한다 —
        // 그러지 않으면 첫 파일(60초)이 끝날 때까지 한 연결로만 돈다.
        expect(realPool.limit).toBe(16)
        expect(inFlight).toBe(16)
        realPool.dispose()
      })

      it('should finish on the open clients without a login storm when further logins fail with 530', async () => {
        const { pool: realPool, createSecondaryClient } = createRealPool()
        const login = createSecondaryClient.getMockImplementation() as () => Promise<unknown>
        let logins = 0
        createSecondaryClient.mockImplementation(async () => {
          logins++
          if (logins <= 2) return login()
          throw new FTPError({ code: 530, message: '530 Login incorrect.' })
        })
        let inFlight = 0
        let peak = 0
        ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          inFlight++
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 50))
          inFlight--
        })
        queue = new TransferQueue(mockFileOps, realPool)

        queue.enqueueBatch('download', items(300))
        await vi.advanceTimersByTimeAsync(60_000)

        // 열린 2개로 끝까지 돌고, 실패하는 로그인을 슬롯이 빌 때마다 되풀이하지 않는다
        const jobs = queue.getAll()
        expect(jobs.filter((job) => job.status !== 'completed')).toEqual([])
        expect(jobs.every((job) => job.retryCount === undefined)).toBe(true)
        expect(peak).toBe(2)
        // 처음 몰린 로그인과, 점점 드물어지는 시험 로그인뿐이다
        expect(createSecondaryClient.mock.calls.length).toBeLessThanOrEqual(
          MAX_TRANSFER_CLIENTS + probesBefore(60_000)
        )
        realPool.dispose()
      })

      /**
       * 0 ms 무렵 처음 실패한 풀이 end 전에 시작할 수 있는 시험 로그인 수. 실패할 때마다 다음 시험 로그인까지
       * 기다리는 시간이 PROBE_COOLDOWN_MS부터 두 배씩(MAX_PROBE_COOLDOWN_MS까지) 늘어난다.
       */
      function probesBefore(end: number): number {
        let probes = 0
        for (let at = PROBE_COOLDOWN_MS, wait = PROBE_COOLDOWN_MS; at < end; probes++) {
          wait = Math.min(wait * 2, MAX_PROBE_COOLDOWN_MS)
          at += wait
        }
        return probes
      }

      /** 처음 몰린 burst개 뒤로 실패한 로그인 사이의 가장 짧은 간격(ms). 그런 실패가 둘보다 적으면 Infinity. */
      function shortestGapAfterBurst(failedAt: number[], burst: number): number {
        const later = [...failedAt].sort((a, b) => a - b).slice(burst)
        return Math.min(...later.slice(1).map((t, i) => t - later[i]))
      }

      it('should not start another burst of failing logins each time a lost client is replaced', async () => {
        // 사용자당 2개까지 받고, 넘으면 연결 수 문구가 없는 530을 주는 서버. 작업마다 연결이 끊겨(EPIPE)
        // 클라이언트가 버려지고 새로 로그인한다. 새 로그인이 될 때마다 limit를 되돌리면 그때마다 실패할
        // 로그인이 limit만큼 몰린다.
        vi.setSystemTime(0)
        const { pool: realPool, createSecondaryClient } = createRealPool()
        const login = createSecondaryClient.getMockImplementation() as () => Promise<FakeClient>
        const CAP = 2
        let open = 0
        const loginTimes: number[] = []
        const failedAt: number[] = []
        createSecondaryClient.mockImplementation(() => {
          loginTimes.push(Date.now())
          return new Promise((resolve, reject) =>
            setTimeout(() => {
              if (open >= CAP) {
                failedAt.push(Date.now())
                reject(new FTPError({ code: 530, message: '530 Login incorrect.' }))
                return
              }
              open++
              void login().then((client) => {
                client.close = vi.fn(() => {
                  if (!client.closed) open--
                  client.closed = true
                })
                resolve(client)
              })
            }, 5)
          )
        })
        ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
        })
        queue = new TransferQueue(mockFileOps, realPool)

        const jobs = 300
        queue.enqueueBatch('download', items(jobs))
        await vi.advanceTimersByTimeAsync(60_000)

        // 실패하는 로그인은 처음 한 번 몰린 것과, 점점 드물어지는 시험 로그인뿐이다. 버려진 클라이언트는
        // limit 안에서 하나씩 대신한다.
        const burst = MAX_TRANSFER_CLIENTS - CAP
        expect(failedAt.length).toBeLessThanOrEqual(burst + probesBefore(60_000))
        expect(shortestGapAfterBurst(failedAt, burst)).toBeGreaterThanOrEqual(PROBE_COOLDOWN_MS)
        expect(loginTimes.length).toBeLessThanOrEqual(jobs + burst + probesBefore(60_000))
        const perSecond = new Map<number, number>()
        for (const t of loginTimes) {
          const s = Math.floor(t / 1000)
          perSecond.set(s, (perSecond.get(s) ?? 0) + 1)
        }
        // 열린 2개가 50 ms마다 하나씩 버려져 새로 로그인하는 속도 + 처음 몰린 로그인
        expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(
          CAP * (1000 / 50) + MAX_TRANSFER_CLIENTS
        )
        expect(queue.getAll().every((job) => job.status === 'failed')).toBe(true)
        realPool.dispose()
      })

      it('should keep failed logins to one per growing wait when failures answer late and logins are slow', async () => {
        // 사용자당 2개까지 받는 서버가 넘는 로그인에 300 ms 뒤 530을 준다(vsftpd의 delay_failed_login처럼).
        // 판정은 로그인을 받을 때 이미 받은 세션 수로 한다. 로그인은 60 ms, 작업은 10 ms이고 작업마다 연결이
        // 끊긴다(EPIPE). 실패가 늦게 오는 동안 열린 클라이언트가 바뀌어도 실패할 로그인이 다시 몰리면 안 된다.
        vi.setSystemTime(0)
        const { pool: realPool, createSecondaryClient } = createRealPool()
        const login = createSecondaryClient.getMockImplementation() as () => Promise<FakeClient>
        const CAP = 2
        let open = 0
        let accepting = 0
        const failedAt: number[] = []
        createSecondaryClient.mockImplementation(() => {
          if (open + accepting >= CAP) {
            return new Promise((_, reject) =>
              setTimeout(() => {
                failedAt.push(Date.now())
                reject(new FTPError({ code: 530, message: '530 Login incorrect.' }))
              }, 300)
            )
          }
          accepting++
          return new Promise((resolve) =>
            setTimeout(() => {
              accepting--
              open++
              void login().then((client) => {
                client.close = vi.fn(() => {
                  if (!client.closed) open--
                  client.closed = true
                })
                resolve(client)
              })
            }, 60)
          )
        })
        ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
        })
        queue = new TransferQueue(mockFileOps, realPool)

        queue.enqueueBatch('download', items(300))
        await vi.advanceTimersByTimeAsync(120_000)

        expect(queue.getAll().every((job) => job.status === 'failed')).toBe(true)
        // 처음 몰린 14개 뒤로는 시험 로그인만 실패하고, 실패 사이는 PROBE_COOLDOWN_MS 이상 벌어진다
        const burst = MAX_TRANSFER_CLIENTS - CAP
        expect(failedAt.length).toBeLessThanOrEqual(burst + probesBefore(120_000))
        expect(shortestGapAfterBurst(failedAt, burst)).toBeGreaterThanOrEqual(PROBE_COOLDOWN_MS)
        realPool.dispose()
      })

      it.each([
        [
          'the last 8 of the first 16 logins fail once',
          (k: number) => (k > 8 && k <= 16 ? 20 : -10)
        ],
        ['the first login fails while the other 15 log in', (k: number) => (k === 1 ? 2 : -30)]
      ])('should run all 16 at once again soon when %s', async (_, answer) => {
        // answer(k): k번째 로그인이 양수 ms 뒤에 530으로 실패하거나, -ms 뒤에 된다. 서버는 16개를 받는다.
        const { pool: realPool, createSecondaryClient } = createRealPool()
        const login = createSecondaryClient.getMockImplementation() as () => Promise<unknown>
        let logins = 0
        createSecondaryClient.mockImplementation(() => {
          const ms = answer(++logins)
          return new Promise((resolve, reject) =>
            setTimeout(
              () =>
                ms > 0
                  ? reject(new FTPError({ code: 530, message: '530 Login incorrect.' }))
                  : resolve(login()),
              Math.abs(ms)
            )
          )
        })
        let inFlight = 0
        let peak = 0
        ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          inFlight++
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 5_000))
          inFlight--
        })
        queue = new TransferQueue(mockFileOps, realPool)

        queue.enqueueBatch('download', items(200))
        // 첫 작업(5초)이 끝나기 전에 시험 로그인으로 16개까지 다시 늘린다
        await vi.advanceTimersByTimeAsync(3_000)
        expect(realPool.limit).toBe(16)
        expect(inFlight).toBe(16)

        await vi.advanceTimersByTimeAsync(120_000)
        expect(queue.getAll().every((job) => job.status === 'completed')).toBe(true)
        expect(peak).toBe(16)
        realPool.dispose()
      })

      it('should never go past a connection limit the server announced while growing back', async () => {
        // 첫 로그인들이 모두 530으로 실패한 뒤, 서버는 4개까지 받고 넘으면 421을 준다. 시험 로그인으로 limit를
        // 늘리다 421을 받으면 거기서 멈춘다.
        const { pool: realPool, createSecondaryClient } = createRealPool()
        const login = createSecondaryClient.getMockImplementation() as () => Promise<FakeClient>
        const CAP = 4
        let logins = 0
        let open = 0
        let tooMany = 0
        createSecondaryClient.mockImplementation(() => {
          const k = ++logins
          return new Promise((resolve, reject) =>
            setTimeout(() => {
              if (k <= MAX_TRANSFER_CLIENTS) {
                reject(new FTPError({ code: 530, message: '530 Login incorrect.' }))
              } else if (open >= CAP) {
                tooMany++
                reject(new FTPError({ code: 421, message: '421 Too many connections' }))
              } else {
                open++
                void login().then((client) => {
                  client.close = vi.fn(() => {
                    if (!client.closed) open--
                    client.closed = true
                  })
                  resolve(client)
                })
              }
            }, 5)
          )
        })
        let inFlight = 0
        let peak = 0
        ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          inFlight++
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 200))
          inFlight--
        })
        queue = new TransferQueue(mockFileOps, realPool)

        queue.enqueueBatch('download', items(300))
        await vi.advanceTimersByTimeAsync(60_000)

        expect(queue.getAll().every((job) => job.status === 'completed')).toBe(true)
        expect(peak).toBe(CAP)
        expect(tooMany).toBe(1)
        realPool.dispose()
      })

      it.each([
        ['530', () => new FTPError({ code: 530, message: '530 Login incorrect.' })],
        [
          'ECONNABORTED',
          () => Object.assign(new Error('read ECONNABORTED'), { code: 'ECONNABORTED' })
        ]
      ])(
        'should run in parallel again after a whole burst of logins fails with %s',
        async (_, error) => {
          const { pool: realPool, createSecondaryClient } = createRealPool()
          const login = createSecondaryClient.getMockImplementation() as () => Promise<unknown>
          let logins = 0
          createSecondaryClient.mockImplementation(() => {
            const n = ++logins
            if (n > MAX_TRANSFER_CLIENTS) return login()
            return new Promise((_, reject) => setTimeout(() => reject(error()), n))
          })
          let inFlight = 0
          let peak = 0
          ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(async () => {
            inFlight++
            peak = Math.max(peak, inFlight)
            await new Promise((resolve) => setTimeout(resolve, 5_000))
            inFlight--
          })
          queue = new TransferQueue(mockFileOps, realPool)

          queue.enqueueBatch('download', items(200))
          await vi.advanceTimersByTimeAsync(120_000)

          // 함께 실패한 로그인이 limit를 1까지 줄여도, 그 뒤 로그인이 되면 설정한 전송 수로 돌아온다
          expect(queue.getAll().every((job) => job.status === 'completed')).toBe(true)
          expect(realPool.limit).toBe(16)
          expect(peak).toBe(16)
          realPool.dispose()
        }
      )

      it('should keep logins bounded and finish on the main client when every login is refused', async () => {
        const { pool: realPool, createSecondaryClient } = createRealPool()
        createSecondaryClient.mockRejectedValue(refusedError())
        queue = new TransferQueue(mockFileOps, realPool)

        queue.enqueueBatch('download', items(500))
        await vi.advanceTimersByTimeAsync(10_000)

        const maxLogins = MAX_TRANSFER_CLIENTS + REFUSED_LOGIN_BACKOFF_MS.length
        expect(createSecondaryClient.mock.calls.length).toBeLessThanOrEqual(maxLogins)
        expect(queue.getAll().every((job) => job.status === 'completed')).toBe(true)
        // client 없이 부르면 FtpFileOperations가 메인 클라이언트로 실행한다
        const download = mockFileOps.download as ReturnType<typeof vi.fn>
        expect(download.mock.calls.every((call) => call[3] === undefined)).toBe(true)

        await vi.advanceTimersByTimeAsync(60_000)
        expect(createSecondaryClient.mock.calls.length).toBeLessThanOrEqual(maxLogins)
        realPool.dispose()
      })
    })
  })

  describe('batch remote directories', () => {
    /** 파일 n개를 dirs 아래에 돌려가며 놓는 업로드 항목 */
    function uploadItems(n: number, dirs: string[]): Parameters<TransferQueue['enqueueBatch']>[1] {
      return Array.from({ length: n }, (_, i) => {
        const dir = dirs[i % dirs.length]
        return {
          localPath: `/local/${i}.txt`,
          remotePath: `${dir}/${i}.txt`,
          fileName: `${i}.txt`,
          totalBytes: 10
        }
      })
    }

    /** 모든 클라이언트의 MKD를 시간 순서대로 모으고, 각 MKD는 테스트가 끝낸다. */
    function trackMkds(): { sent: string[]; finish: Map<string, () => void> } {
      const sent: string[] = []
      const finish = new Map<string, () => void>()
      pool.acquire.mockImplementation(async () => {
        const client = createFakeClient()
        client.sendIgnoringError.mockImplementation((command: string) => {
          const dir = command.replace('MKD ', '')
          sent.push(dir)
          return new Promise((resolve) => finish.set(dir, () => resolve(MKD_OK)))
        })
        pool.clients.push(client)
        return client
      })
      return { sent, finish }
    }

    it('should send exactly one MKD per unique dir, parents first, and none for the target', async () => {
      pool.limit = 10
      const { sent, finish } = trackMkds()
      queue.enqueueBatch('upload', uploadItems(30, ['/t/a', '/t/a/b', '/t/c']), true, [
        '/t/a',
        '/t/a/b',
        '/t/c'
      ])
      await settle()

      // 가장 얕은 디렉터리만 먼저 나가고, /t/a/b는 /t/a가 끝날 때까지 기다린다
      expect(sent.sort()).toEqual(['/t/a', '/t/c'])
      expect(mockFileOps.upload).not.toHaveBeenCalled()

      finish.get('/t/a')!()
      await settle()
      expect(sent).toContain('/t/a/b')

      finish.get('/t/c')!()
      finish.get('/t/a/b')!()
      await settle()

      expect(sent).toHaveLength(3)
      expect(sent.every((dir) => dir.startsWith('/t/'))).toBe(true)
      expect(mockFileOps.upload).toHaveBeenCalledTimes(30)
      expect(queue.getAll().every((job) => job.status === 'completed')).toBe(true)
    })

    it('should let concurrent jobs in the same dir share one MKD and wait for it', async () => {
      pool.limit = 3
      const { sent, finish } = trackMkds()
      queue.enqueueBatch('upload', uploadItems(5, ['/t/a']), true, ['/t/a'])
      await settle()

      expect(sent).toEqual(['/t/a'])
      expect(mockFileOps.upload).not.toHaveBeenCalled()

      finish.get('/t/a')!()
      await settle()

      expect(sent).toEqual(['/t/a'])
      expect(mockFileOps.upload).toHaveBeenCalledTimes(5)
    })

    it('should retry a rejected MKD from the next job', async () => {
      pool.limit = 1
      const mkd = vi
        .fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValue(MKD_OK)
      pool.acquire.mockImplementation(async () => {
        const client = createFakeClient()
        client.sendIgnoringError = mkd
        pool.clients.push(client)
        return client
      })

      queue.enqueueBatch('upload', uploadItems(2, ['/t/a']), true, ['/t/a'])
      await settle()

      expect(mkd).toHaveBeenCalledTimes(2)
      expect(queue.getAll().map((job) => job.status)).toEqual(['failed', 'completed'])
      expect(mockFileOps.upload).toHaveBeenCalledTimes(1)
    })

    it('should emit one dir:created per created dir, after its MKD', async () => {
      pool.limit = 3
      const created: string[] = []
      queue.on('dir:created', (dir: string) => created.push(dir))
      const { finish } = trackMkds()
      queue.enqueueBatch('upload', uploadItems(6, ['/t/a', '/t/a/b']), true, ['/t/a', '/t/a/b'])
      await settle()
      expect(created).toEqual([])

      finish.get('/t/a')!()
      await settle()
      finish.get('/t/a/b')!()
      await settle()

      expect(created).toEqual(['/t/a', '/t/a/b'])
    })

    it('should not memo across batches, so a folder deleted in between is created again', async () => {
      pool.limit = 3
      const mkds: string[] = []
      pool.acquire.mockImplementation(async () => {
        const client = createFakeClient()
        client.sendIgnoringError.mockImplementation(async (command: string) => {
          mkds.push(command)
          return MKD_OK
        })
        return client
      })

      queue.enqueueBatch('upload', uploadItems(2, ['/t/a']), true, ['/t/a'])
      await settle()
      queue.enqueueBatch('upload', uploadItems(2, ['/t/a']), true, ['/t/a'])
      await settle()

      expect(mkds).toEqual(['MKD /t/a', 'MKD /t/a'])
    })

    it('should send no MKD for dirs outside the batch set or for a batch without remoteDirs', async () => {
      const mkds: string[] = []
      pool.acquire.mockImplementation(async () => {
        const client = createFakeClient()
        client.sendIgnoringError.mockImplementation(async (command: string) => {
          mkds.push(command)
          return MKD_OK
        })
        return client
      })

      queue.enqueueBatch('upload', uploadItems(3, ['/t']), true)
      queue.enqueueBatch('upload', uploadItems(3, ['/t']), true, ['/t/a'])
      await settle()

      expect(mkds).toEqual([])
      expect(mockFileOps.upload).toHaveBeenCalledTimes(6)
    })

    it('should not create dirs for a download batch', async () => {
      queue.enqueueBatch('download', items(3), true, ['/remote/x'])
      await settle()

      expect(pool.clients.every((c) => c.sendIgnoringError.mock.calls.length === 0)).toBe(true)
      expect(mockFileOps.download).toHaveBeenCalledTimes(3)
    })

    it('should create the batch dirs on the main client when the pool falls back', async () => {
      pool.limit = 1
      pool.acquire.mockResolvedValue(null)
      const order: string[] = []
      pool.main.sendIgnoringError.mockImplementation(async (command: string) => {
        order.push(command)
        return MKD_OK
      })
      ;(mockFileOps.upload as ReturnType<typeof vi.fn>).mockImplementation(
        async (_local: string, remote: string) => {
          order.push(`STOR ${remote}`)
        }
      )

      queue.enqueueBatch('upload', uploadItems(2, ['/t/new/sub']), true, ['/t/new', '/t/new/sub'])
      await settle()

      // 메인 클라이언트로도 같은 메모를 써서 디렉터리마다 한 번씩, 부모부터 만든 뒤 올린다
      expect(order).toEqual([
        'MKD /t/new',
        'MKD /t/new/sub',
        'STOR /t/new/sub/0.txt',
        'STOR /t/new/sub/1.txt'
      ])
      expect(queue.getAll().map((job) => job.status)).toEqual(['completed', 'completed'])
    })

    it('should redo the MKD on its own client when the job that sent it is cancelled', async () => {
      pool.limit = 3
      pool.acquire.mockImplementation(async () => {
        const client = createFakeClient()
        if (pool.clients.length === 0) {
          // 첫 작업의 MKD는 응답 전에 멈춰 있다가, 취소로 클라이언트가 닫히면 reject된다
          client.sendIgnoringError.mockImplementation(
            () =>
              new Promise((_resolve, reject) => {
                client.close.mockImplementation(() => {
                  client.closed = true
                  reject(new Error('User closed client during task'))
                })
              })
          )
        }
        pool.clients.push(client)
        return client
      })
      const upload = mockFileOps.upload as ReturnType<typeof vi.fn>

      const ids = queue.enqueueBatch(
        'upload',
        [
          { localPath: '/local/0', remotePath: '/t/a/0', fileName: '0', totalBytes: 1 },
          { localPath: '/local/1', remotePath: '/t/a/b/1', fileName: '1', totalBytes: 1 },
          { localPath: '/local/2', remotePath: '/t/a/2', fileName: '2', totalBytes: 1 }
        ],
        true,
        ['/t/a', '/t/a/b']
      )
      await settle()
      expect(upload).not.toHaveBeenCalled()

      queue.cancel(ids[0])
      await settle()

      // 남은 작업 중 하나가 자기 연결로 /t/a를 다시 만들고, 다른 작업은 그 MKD를 함께 기다린다
      const sent = pool.clients.map((c) => c.sendIgnoringError.mock.calls.map((call) => call[0]))
      expect(sent).toEqual([['MKD /t/a'], ['MKD /t/a', 'MKD /t/a/b'], []])
      expect(queue.getAll().map((job) => job.status)).toEqual([
        'cancelled',
        'completed',
        'completed'
      ])
      expect(pool.releaseAfterError).not.toHaveBeenCalled()
      expect(upload).toHaveBeenCalledTimes(2)
    })

    it('should emit dir:created only for an MKD that the server accepted', async () => {
      const created: string[] = []
      queue.on('dir:created', (dir: string) => created.push(dir))
      pool.acquire.mockImplementation(async () => {
        const client = createFakeClient()
        client.sendIgnoringError.mockImplementation(async (command: string) =>
          command === 'MKD /t/exists'
            ? { code: 550, message: '550 File exists' }
            : { code: 257, message: '257 created' }
        )
        return client
      })

      queue.enqueueBatch('upload', uploadItems(2, ['/t/exists', '/t/exists/new']), true, [
        '/t/exists',
        '/t/exists/new'
      ])
      await settle()

      expect(created).toEqual(['/t/exists/new'])
      expect(mockFileOps.upload).toHaveBeenCalledTimes(2)
    })

    it('should create the dir of an upcoming job before its own upload so the others do not stall on it', async () => {
      pool.limit = 3
      const { sent, finish } = trackMkds()
      const upload = deferTransfers(mockFileOps.upload)
      const paths = ['/t/a/0', '/t/a/1', '/t/a/2', '/t/a/3', '/t/b/4', '/t/b/5']
      queue.enqueueBatch(
        'upload',
        paths.map((remotePath, i) => ({
          localPath: `/local/${i}`,
          remotePath,
          fileName: `${i}`,
          totalBytes: 1
        })),
        true,
        ['/t/a', '/t/b']
      )
      await settle()
      expect(sent).toEqual(['/t/a'])

      finish.get('/t/a')!()
      await settle()
      // 자기 폴더가 준비된 첫 클라이언트가 큐 앞 pool.limit개 안의 /t/b를 자기 STOR 전에 만든다.
      // 나머지 둘은 기다리지 않고 바로 올린다.
      const commands = (): string[][] =>
        pool.clients.map((c) => c.sendIgnoringError.mock.calls.map((call) => call[0]))
      expect(commands()).toEqual([['MKD /t/a', 'MKD /t/b'], [], []])
      expect([...upload.keys()].sort()).toEqual(['/t/a/1', '/t/a/2'])

      finish.get('/t/b')!()
      await settle()
      expect(upload.has('/t/a/0')).toBe(true)

      for (const remote of ['/t/a/0', '/t/a/1', '/t/a/2']) upload.get(remote)!.resolve()
      await settle()
      // /t/b의 작업들은 이미 만든 폴더라 MKD를 기다리지도 보내지도 않는다
      expect(upload.has('/t/b/4')).toBe(true)
      expect(upload.has('/t/b/5')).toBe(true)
      expect(sent).toEqual(['/t/a', '/t/b'])
    })

    it('should let an upcoming job redo a dir made ahead when the job that sent it is cancelled', async () => {
      pool.limit = 2
      pool.acquire.mockImplementation(async () => {
        const client = createFakeClient()
        if (pool.clients.length === 0) {
          // 미리 보낸 /t/b의 MKD는 응답 전에 멈춰 있다가, 취소로 클라이언트가 닫히면 reject된다
          client.sendIgnoringError.mockImplementation((command: string) =>
            command === 'MKD /t/a'
              ? Promise.resolve(MKD_OK)
              : new Promise((_resolve, reject) => {
                  client.close.mockImplementation(() => {
                    client.closed = true
                    reject(new Error('User closed client during task'))
                  })
                })
          )
        }
        pool.clients.push(client)
        return client
      })

      const ids = queue.enqueueBatch(
        'upload',
        [
          { localPath: '/local/0', remotePath: '/t/a/0', fileName: '0', totalBytes: 1 },
          { localPath: '/local/1', remotePath: '/t/a/1', fileName: '1', totalBytes: 1 },
          { localPath: '/local/2', remotePath: '/t/b/2', fileName: '2', totalBytes: 1 }
        ],
        true,
        ['/t/a', '/t/b']
      )
      await settle()
      queue.cancel(ids[0])
      await settle()

      const sent = pool.clients.map((c) => c.sendIgnoringError.mock.calls.map((call) => call[0]))
      expect(sent).toEqual([['MKD /t/a', 'MKD /t/b'], [], ['MKD /t/b']])
      expect(queue.getAll().map((job) => job.status)).toEqual([
        'cancelled',
        'completed',
        'completed'
      ])
    })

    it('should create the dir for a single-file batch that has no batchId', async () => {
      const { sent, finish } = trackMkds()
      queue.enqueueBatch('upload', uploadItems(1, ['/t/a']), false, ['/t/a'])
      await settle()
      expect(sent).toEqual(['/t/a'])

      finish.get('/t/a')!()
      await settle()
      expect(mockFileOps.upload).toHaveBeenCalledTimes(1)
    })
  })

  describe('segmented download', () => {
    const CHUNK = 100
    /** planSegments(4000, 3, 4000, 1000): [0,1334) [1334,2667) [2667,4000) */
    const STARTS = [0, 1334, 2667]
    const FINAL = 2667
    const source = Buffer.from(Array.from({ length: SEG_MIN }, (_, i) => (i * 7 + 3) % 256))

    interface SegmentClient extends FakeClient {
      /** 평문 제어 연결. downloadInto가 데이터 소켓 생성 함수를 바꿔 끼운다(이 가짜 downloadTo는 쓰지 않는다). */
      ftp: { socket: object; _newSocket: () => net.Socket }
      size: ReturnType<typeof vi.fn>
      downloadTo: ReturnType<typeof vi.fn>
    }

    /** 구간 시작 오프셋별로 가짜 서버의 동작을 고른다. */
    interface FakeServer {
      /** REST를 받아들이고도 0부터 보낸다 */
      ignoreRest: boolean
      /** 첫 청크를 보낸 뒤 멈춰 둘 게이트 */
      holds: Map<number, Deferred>
      /** 게이트 뒤에 둘째 청크를 보내고 한 번 멈춰 둘 게이트. 판정 순간의 버퍼를 둘째 청크로 고정한다. */
      stalls: Map<number, Deferred>
      /** 첫 청크(와 게이트) 뒤에 한 번 던질 에러 */
      failures: Map<number, unknown>
      /** 한 바이트도 보내기 전에 던질 에러(REST 거부 등) */
      rejections: Map<number, unknown>
      /** 전송 시작 순서: 구간은 'seg <start>' */
      events: string[]
      /** SIZE 응답 시간. 기본은 LAN 기준의 두 배라 기존 분할 경로(WAN)를 탄다. 0이면 LAN으로 본다. */
      sizeDelayMs: number
    }

    let dir: string
    let localPath: string
    let server: FakeServer

    /** basic-ftp처럼 데이터 소켓을 Writable로 pipeline하고, 스트림이 끊기면 클라이언트를 닫는 가짜 클라이언트 */
    function createSegmentClient(): SegmentClient {
      const client = createFakeClient() as SegmentClient
      client.ftp = { socket: {}, _newSocket: () => new net.Socket() }
      let abort: (err: Error) => void = () => {}
      const aborted = new Promise<never>((_, reject) => {
        abort = reject
      })
      aborted.catch(() => {})
      client.close.mockImplementation(() => {
        client.closed = true
        abort(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }))
      })
      client.size = vi.fn(async () => {
        if (server.sizeDelayMs > 0) await new Promise((r) => setTimeout(r, server.sizeDelayMs))
        return source.length
      })
      client.downloadTo = vi.fn(async (writer: Writable, _remote: string, start = 0) => {
        server.events.push(`seg ${start}`)
        const rejection = server.rejections.get(start)
        if (rejection) throw rejection
        const body = server.ignoreRest ? source : source.subarray(start)
        async function* chunks(): AsyncGenerator<Buffer> {
          yield body.subarray(0, CHUNK)
          const hold = server.holds.get(start)
          if (hold) await Promise.race([hold.promise, aborted])
          let next = CHUNK
          const stall = server.stalls.get(start)
          if (stall) {
            server.stalls.delete(start)
            yield body.subarray(CHUNK, 2 * CHUNK)
            next = 2 * CHUNK
            await Promise.race([stall.promise, aborted])
          }
          const failure = server.failures.get(start)
          if (failure) {
            server.failures.delete(start)
            throw failure
          }
          for (let i = next; i < body.length; i += CHUNK) yield body.subarray(i, i + CHUNK)
        }
        try {
          await pipeline(Readable.from(chunks()), writer)
        } catch (err) {
          // 스트림이 중간에 끊기면 basic-ftp는 closeWithError로 클라이언트를 닫는다
          if (!(err instanceof FTPError)) client.closed = true
          throw err
        }
      })
      return client
    }

    function segmentClients(): SegmentClient[] {
      return pool.clients as SegmentClient[]
    }

    function enqueueBig(): string {
      return queue.enqueue('download', localPath, '/remote/big.bin', 'big.bin', SEG_MIN)
    }

    function big(): TransferJob {
      return queue.getAll().find((job) => job.fileName === 'big.bin')!
    }

    function holdAll(): void {
      for (const start of STARTS) server.holds.set(start, deferred())
    }

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-seg-'))
      localPath = path.join(dir, 'big.bin')
      server = {
        ignoreRest: false,
        holds: new Map(),
        stalls: new Map(),
        failures: new Map(),
        rejections: new Map(),
        events: [],
        sizeDelayMs: 2 * LAN_RTT_MS
      }
      pool.acquire.mockImplementation(async () => {
        const client = createSegmentClient()
        pool.clients.push(client)
        return client
      })
      sizesAtMark = []
      vi.mocked(markSparse).mockImplementation(async (file) => {
        sizesAtMark.push(fs.fstatSync(file.fd).size)
        return true
      })
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', platform)
      fs.rmSync(dir, { recursive: true, force: true })
    })

    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    /** markSparse가 불린 순간의 로컬 파일 크기. 0이면 SIZE 크기로 늘리기 전에 불렸다. */
    let sizesAtMark: number[]

    function setPlatform(value: NodeJS.Platform): void {
      Object.defineProperty(process, 'platform', { ...platform, value })
    }

    it('should run the final range on the head client and queue the other ranges ahead of later jobs', async () => {
      const small = deferTransfers(mockFileOps.download)
      const download = mockFileOps.download as ReturnType<typeof vi.fn>
      const deferredDownload = download.getMockImplementation() as (
        ...args: unknown[]
      ) => Promise<void>
      download.mockImplementation((remote: string, ...rest: unknown[]) => {
        server.events.push(`file ${remote}`)
        return deferredDownload(remote, ...rest)
      })

      queue.enqueueBatch('download', [
        { localPath, remotePath: '/remote/big.bin', fileName: 'big.bin', totalBytes: SEG_MIN },
        ...items(3)
      ])
      await vi.waitFor(() => expect(server.events).toContain(`seg ${FINAL}`))
      small.get('/remote/0.jpg')!.resolve()
      small.get('/remote/1.jpg')!.resolve()
      await vi.waitFor(() => expect(big().status).toBe('completed'))
      await vi.waitFor(() => expect(server.events).toContain('file /remote/2.jpg'))

      const [head] = segmentClients()
      expect(head.size).toHaveBeenCalledWith('/remote/big.bin')
      // 앞의 두 파일은 이미 슬롯을 잡았고, 뒤의 파일보다 구간 항목이 먼저 슬롯을 받는다
      expect(server.events).toEqual([
        'file /remote/0.jpg',
        'file /remote/1.jpg',
        `seg ${FINAL}`,
        'seg 0',
        'seg 1334',
        'file /remote/2.jpg'
      ])
      expect(head.downloadTo.mock.calls[0].slice(1)).toEqual(['/remote/big.bin', FINAL])
      expect(fs.readFileSync(localPath).equals(source)).toBe(true)
      expect(big().transferredBytes).toBe(SEG_MIN)
    })

    it('should count a range that stops at its length as done, discard its client and keep the final one', async () => {
      enqueueBig()
      await vi.waitFor(() => expect(big().status).toBe('completed'))

      const clients = segmentClients()
      const head = clients[0]
      const others = clients.slice(1)
      expect(others.map((c) => c.downloadTo.mock.calls[0][2])).toEqual([0, 1334])
      // 앞 구간의 downloadTo는 len에서 끊겨 reject되지만 성공이다. 끊긴 클라이언트는 한 번 쓰고 버린다.
      for (const client of others) expect(pool.discard).toHaveBeenCalledWith(client)
      expect(pool.release).toHaveBeenCalledWith(head)
      expect(pool.releaseAfterError).not.toHaveBeenCalled()
      expect(big().retryCount).toBeUndefined()
      expect(mockFileOps.download).not.toHaveBeenCalled()
    })

    it('should keep a fallback error listener on a range writer whose transfer failed before any data', async () => {
      // 제어 응답이 먼저 실패하면 basic-ftp는 pipeline을 걸지 않고 자기 'error' 리스너도 뗀다
      server.rejections.set(
        1334,
        new FTPError({ code: 425, message: "425 Can't open data connection" })
      )

      enqueueBig()
      await vi.waitFor(() => expect(big().status).toBe('completed'))

      const failed = segmentClients().find((c) => c.downloadTo.mock.calls[0]?.[2] === 1334)!
      const writer = failed.downloadTo.mock.calls[0][0] as Writable
      // 슬랩 경로는 150 전에도 디스크 쓰기를 시작하므로 그 쓰기의 에러가 뒤늦게 올 수 있다
      expect(() => writer.emit('error', new Error('EIO: i/o error, write'))).not.toThrow()
    })

    it('should report progress as the sum of all ranges', async () => {
      holdAll()
      const listener = vi.fn()
      queue.on('queue:updated', listener)

      enqueueBig()
      await vi.waitFor(() => expect(big().transferredBytes).toBe(3 * CHUNK))
      await vi.advanceTimersByTimeAsync(100)

      const update = listener.mock.calls.at(-1)![0] as TransferUpdate
      expect(update.upserts[0]).toMatchObject({ status: 'active', transferredBytes: 3 * CHUNK })

      for (const start of STARTS) server.holds.get(start)!.resolve()
      await vi.waitFor(() => expect(big().status).toBe('completed'))
      expect(fs.readFileSync(localPath).equals(source)).toBe(true)
    })

    it('should fall back to one stream on the same client when SIZE fails', async () => {
      pool.acquire.mockImplementationOnce(async () => {
        const client = createSegmentClient()
        client.size.mockRejectedValue(new FTPError({ code: 550, message: 'SIZE not allowed' }))
        pool.clients.push(client)
        return client
      })

      enqueueBig()
      await vi.waitFor(() => expect(big().status).toBe('completed'))

      const [client] = segmentClients()
      expect(pool.clients).toHaveLength(1)
      expect(client.downloadTo).not.toHaveBeenCalled()
      expect(mockFileOps.download).toHaveBeenCalledWith(
        '/remote/big.bin',
        localPath,
        expect.any(Function),
        client
      )
    })

    it('should not split a small download, a pool of one, or a connection whose REST is broken', async () => {
      queue.enqueue('download', localPath, '/remote/small.bin', 'small.bin', SEG_MIN - 1)
      await vi.waitFor(() => expect(mockFileOps.download).toHaveBeenCalledTimes(1))

      pool.limit = 1
      enqueueBig()
      await vi.waitFor(() => expect(mockFileOps.download).toHaveBeenCalledTimes(2))

      pool.limit = 3
      pool.segmentedBroken = true
      enqueueBig()
      await vi.waitFor(() => expect(mockFileOps.download).toHaveBeenCalledTimes(3))

      expect(segmentClients().every((c) => c.size.mock.calls.length === 0)).toBe(true)
    })

    it('should mark REST broken and re-run one stream after the other ranges stop when the final range overflows', async () => {
      server.ignoreRest = true
      holdAll()
      const download = mockFileOps.download as ReturnType<typeof vi.fn>
      const atRestart: Array<Pick<TransferJob, 'status' | 'transferredBytes'>> = []
      download.mockImplementation(async () => {
        atRestart.push({ status: big().status, transferredBytes: big().transferredBytes })
      })

      enqueueBig()
      await vi.waitFor(() => expect(big().transferredBytes).toBe(3 * CHUNK))
      // 서버가 REST를 무시하므로 최종 구간은 제 길이보다 많이 받는다
      server.holds.get(FINAL)!.resolve()
      await vi.waitFor(() => expect(big().status).toBe('completed'))

      const [head, first, second, single] = segmentClients()
      expect(pool.segmentedBroken).toBe(true)
      expect(pool.discard).toHaveBeenCalledWith(head)
      // 다른 구간 클라이언트를 닫아 끊고, 그 구간들이 멈춘 뒤에야 새 클라이언트로 한 스트림을 받는다
      expect(first.close).toHaveBeenCalled()
      expect(second.close).toHaveBeenCalled()
      expect(download).toHaveBeenCalledTimes(1)
      expect(download.mock.calls[0][3]).toBe(single)
      expect(atRestart).toEqual([{ status: 'active', transferredBytes: 0 }])
      expect(big().retryCount).toBeUndefined()
      expect(big().transferredBytes).toBe(SEG_MIN)
    })

    it('should re-run one stream only once when the overflowing range is the last one running', async () => {
      server.ignoreRest = true
      server.holds.set(FINAL, deferred())

      enqueueBig()
      // 앞 구간은 모두 끝나고(REST 무시로 내용은 틀려도 길이는 맞다) 최종 구간만 남는다
      await vi.waitFor(() => expect(big().transferredBytes).toBe(1334 + 1333 + CHUNK))
      server.holds.get(FINAL)!.resolve()
      await vi.waitFor(() => expect(big().status).toBe('completed'))
      await vi.advanceTimersByTimeAsync(100)

      expect(pool.segmentedBroken).toBe(true)
      expect(mockFileOps.download).toHaveBeenCalledTimes(1)
    })

    it('should fall back to one stream the same way when the server rejects REST', async () => {
      const restRejected = new FTPError({ code: 502, message: 'REST not implemented' })
      server.rejections.set(1334, restRejected)
      server.rejections.set(FINAL, restRejected)

      enqueueBig()
      await vi.waitFor(() => expect(big().status).toBe('completed'))

      expect(pool.segmentedBroken).toBe(true)
      expect(mockFileOps.download).toHaveBeenCalledTimes(1)
      expect(big().retryCount).toBeUndefined()
    })

    it('should close every range client, drop queued ranges and unlink the file on cancel', async () => {
      // 먼저 슬롯 하나를 잡은 파일 때문에 [1334, 2667) 구간은 큐에서 기다린다
      const small = deferTransfers(mockFileOps.download)
      holdAll()
      queue.enqueue('download', '/local/first.jpg', '/remote/first.jpg', 'first.jpg', 10)
      const id = enqueueBig()
      await vi.waitFor(() => expect(big().transferredBytes).toBe(2 * CHUNK))

      queue.cancel(id)
      await vi.waitFor(() => expect(unlink).toHaveBeenCalledWith(localPath))
      small.get('/remote/first.jpg')!.resolve()
      await vi.advanceTimersByTimeAsync(5000)

      const clients = segmentClients().filter((c) => c.downloadTo.mock.calls.length > 0)
      expect(clients.map((c) => c.downloadTo.mock.calls[0][2])).toEqual([FINAL, 0])
      for (const client of clients) {
        expect(client.close).toHaveBeenCalled()
        expect(pool.discard).toHaveBeenCalledWith(client)
      }
      expect(server.events).not.toContain('seg 1334')
      expect(big().status).toBe('cancelled')
      expect(big().retryCount).toBeUndefined()
      expect(mockFileOps.download).toHaveBeenCalledTimes(1)
    })

    it('should retry only the failed range and keep the job active meanwhile', async () => {
      server.failures.set(1334, Object.assign(new Error('reset'), { code: 'ECONNRESET' }))

      enqueueBig()
      // 실패한 구간이 받은 만큼은 진행률에서 뺀다: 4000 - 1333
      await vi.waitFor(() => {
        expect(big().retryCount).toBe(1)
        expect(big().transferredBytes).toBe(SEG_MIN - 1333)
      })
      expect(big().status).toBe('active')
      expect(big().error).toMatch(/^Retry 1\/3/)

      await vi.advanceTimersByTimeAsync(2000)
      await vi.waitFor(() => expect(big().status).toBe('completed'))

      expect(server.events.filter((e) => e.startsWith('seg')).sort()).toEqual([
        'seg 0',
        'seg 1334',
        'seg 1334',
        `seg ${FINAL}`
      ])
      expect(fs.readFileSync(localPath).equals(source)).toBe(true)
      expect(big().transferredBytes).toBe(SEG_MIN)
    })

    it('should fail the job and close the other range clients on a non-retryable range error', async () => {
      holdAll()
      server.failures.set(0, new FTPError({ code: 550, message: 'Permission denied' }))

      enqueueBig()
      await vi.waitFor(() => expect(big().transferredBytes).toBe(3 * CHUNK))
      server.holds.get(0)!.resolve()
      await vi.waitFor(() => expect(big().status).toBe('failed'))

      const [head, first, second] = segmentClients()
      expect(first.downloadTo.mock.calls[0][2]).toBe(0)
      expect(head.close).toHaveBeenCalled()
      expect(second.close).toHaveBeenCalled()
      expect(big().error).toBe('Permission denied or file/directory not found.')
      expect(big().retryCount).toBeUndefined()
      expect(mockFileOps.download).not.toHaveBeenCalled()
      // 미리 늘려 둔 파일은 크기만 서버와 같고 0으로 찬 구멍이 있으므로 남기지 않는다
      await vi.waitFor(() => expect(unlink).toHaveBeenCalledWith(localPath))
    })

    it('should give each range its own retry budget', async () => {
      // 4구간: [0,1000) [1000,2000) [2000,3000) [3000,4000). 네트워크가 한 번 끊겨 모든 구간이 한 번씩 실패한다.
      pool.limit = 4
      for (const start of [0, 1000, 2000, 3000]) {
        server.failures.set(start, Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      }

      enqueueBig()
      await vi.waitFor(() => expect(server.failures.size).toBe(0))
      await vi.advanceTimersByTimeAsync(2000)
      await vi.waitFor(() => expect(big().status).toBe('completed'))

      expect(big().retryCount).toBe(1)
      expect(fs.readFileSync(localPath).equals(source)).toBe(true)
    })

    it('should not treat a pre-data error other than a REST reply as broken REST', async () => {
      // 구간 시작 전에 파일이 지워졌다: RETR의 550이지 REST 거부가 아니다.
      // 한 스트림으로 다시 받아 보고, 거기서도 나는 550이 작업을 실패시킨다.
      const noSuchFile = new FTPError({ code: 550, message: 'No such file' })
      server.rejections.set(1334, noSuchFile)
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockRejectedValue(noSuchFile)

      enqueueBig()
      await vi.waitFor(() => expect(big().status).toBe('failed'))
      await vi.advanceTimersByTimeAsync(100)

      expect(pool.segmentedBroken).toBe(false)
      expect(big().error).toBe('Permission denied or file/directory not found.')
      expect(mockFileOps.download).toHaveBeenCalledTimes(1)
    })

    it.each([
      [451, 'Append/Restart not permitted, try again'],
      [554, 'Invalid REST parameter']
    ])(
      'should re-run one stream without marking REST broken when a range RETR gets %i',
      async (code, message) => {
        // REST에는 350으로 답하고 이어받는 RETR만 거부하는 서버: 한 스트림은 받을 수 있다
        const refused = new FTPError({ code, message: `${code} ${message}` })
        server.rejections.set(1334, refused)
        server.rejections.set(FINAL, refused)

        enqueueBig()
        await vi.waitFor(() => expect(big().status).toBe('completed'))

        expect(pool.segmentedBroken).toBe(false)
        expect(mockFileOps.download).toHaveBeenCalledTimes(1)
      }
    )

    it('should give the one-stream re-run a fresh retry budget and clear the range error', async () => {
      // [1334, 2667) 구간이 연결 끊김으로 재시도를 다 쓴 뒤에 REST가 거부된다
      server.rejections.set(1334, Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      const download = mockFileOps.download as ReturnType<typeof vi.fn>
      const atRestart: Array<Pick<TransferJob, 'retryCount' | 'error'>> = []
      download.mockImplementationOnce(async () => {
        atRestart.push({ retryCount: big().retryCount, error: big().error })
        throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })
      })

      enqueueBig()
      for (let attempt = 1; attempt <= 3; attempt++) {
        await vi.waitFor(() => expect(big().retryCount).toBe(attempt))
        if (attempt === 3) {
          server.rejections.set(1334, new FTPError({ code: 502, message: 'REST not implemented' }))
        }
        await vi.advanceTimersByTimeAsync(2000)
      }
      await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(2000)
      await vi.waitFor(() => expect(big().status).toBe('completed'))

      expect(atRestart).toEqual([{ retryCount: undefined, error: undefined }])
      expect(download).toHaveBeenCalledTimes(2)
      expect(big().retryCount).toBe(1)
    })

    it('should fail rather than complete when the ranges did not write the whole file', async () => {
      // 구간 계획에 빈틈이 있으면 [1000,2000)은 아무도 쓰지 않은 0으로 남는다
      vi.mocked(planSegments).mockImplementationOnce(() => [
        { start: 0, end: 1000, final: false },
        { start: 2000, end: SEG_MIN, final: true }
      ])

      enqueueBig()
      await vi.waitFor(() => expect(big().status).toBe('failed'))

      expect(big().error).toBe('Downloaded file size does not match the server')
      await vi.waitFor(() => expect(unlink).toHaveBeenCalledWith(localPath))
    })

    it('should mark the file sparse on Windows before growing it to the server size', async () => {
      // NTFS는 늘리기만 한 파일의 끝쪽에 처음 쓸 때 그 앞을 0으로 채우며 모든 구간의 쓰기를 막는다
      setPlatform('win32')

      enqueueBig()
      await vi.waitFor(() => expect(big().status).toBe('completed'))

      expect(markSparse).toHaveBeenCalledTimes(1)
      expect(sizesAtMark).toEqual([0])
      expect(fs.readFileSync(localPath).equals(source)).toBe(true)
    })

    it.each(['darwin', 'linux'] as const)('should not mark the file sparse on %s', async (os) => {
      setPlatform(os)

      enqueueBig()
      await vi.waitFor(() => expect(big().status).toBe('completed'))

      expect(markSparse).not.toHaveBeenCalled()
      expect(fs.readFileSync(localPath).equals(source)).toBe(true)
    })

    it.each([
      ['returns false', () => Promise.resolve(false)],
      ['rejects', () => Promise.reject(new Error('Cannot find the native Koffi module'))]
    ])('should still download in ranges when marking the file sparse %s', async (_, outcome) => {
      // 희소 표시는 최적화일 뿐이다: 실패해도 작업을 실패시키거나 한 스트림으로 바꾸지 않는다
      setPlatform('win32')
      vi.mocked(markSparse).mockImplementation(outcome)

      enqueueBig()
      await vi.waitFor(() => expect(big().status).toBe('completed'))

      expect(server.events.sort()).toEqual(['seg 0', 'seg 1334', `seg ${FINAL}`])
      expect(big().retryCount).toBeUndefined()
      expect(fs.readFileSync(localPath).equals(source)).toBe(true)
    })

    describe('on a LAN (SIZE answers faster than LAN_RTT_MS)', () => {
      /**
       * 첫 청크 뒤 PROBE_MS보다 오래 멈춘 머리 스트림은 둘째 청크에서 느리다고 판정된다. 판정 순간 받아 둔
       * 끝은 300(쓴 200 + 쓰고 있는 100)이고, 남은 3700바이트를 3개로 나눠 머리가 첫 조각 [300, 1534)까지
       * 이어 받는다. 새 구간은 [1534, 2767) [2767, 4000)이다.
       */
      const CUT = 1534
      const REST_STARTS = [CUT, 2767]

      beforeEach(() => {
        server.sizeDelayMs = 0
      })

      /**
       * 가짜 시간을 흘리지 않고 작업이 끝나기를 기다린다. vi.waitFor는 확인할 때마다 가짜 시간을 앞당겨,
       * 빠른 스트림도 느리다고 판정하게 만든다.
       */
      function settled(): Promise<void> {
        return new Promise((resolve) => {
          const check = (): void => {
            const status = big()?.status
            if (status === 'completed' || status === 'failed') {
              queue.off('queue:updated', check)
              resolve()
            }
          }
          queue.on('queue:updated', check)
        })
      }

      /** 분할 뒤 머리 스트림을 둘째 청크에서 멈춰 둔 게이트 */
      let headStall: Deferred

      /** 머리 스트림을 첫 청크 뒤에 PROBE_MS보다 오래 멈췄다가 둘째 청크에서 판정하게 하고, 분할을 기다린다. */
      async function splitSlowHead(): Promise<string> {
        const hold = deferred()
        headStall = deferred()
        server.holds.set(0, hold)
        server.stalls.set(0, headStall)
        const id = enqueueBig()
        await vi.waitFor(() => expect(big().transferredBytes).toBe(CHUNK))
        await vi.advanceTimersByTimeAsync(PROBE * 2)
        hold.resolve()
        await vi.waitFor(() => expect(server.events).toHaveLength(3))
        return id
      }

      it('should receive the whole file over one stream on one client', async () => {
        const done = settled()
        enqueueBig()
        await done

        expect(big().status).toBe('completed')
        expect(server.events).toEqual(['seg 0'])
        const [head] = segmentClients()
        expect(pool.clients).toHaveLength(1)
        expect(head.size).toHaveBeenCalledWith('/remote/big.bin')
        expect(head.downloadTo.mock.calls[0].slice(1)).toEqual(['/remote/big.bin', 0])
        expect(pool.release).toHaveBeenCalledWith(head)
        expect(mockFileOps.download).not.toHaveBeenCalled()
        expect(fs.readFileSync(localPath).equals(source)).toBe(true)
        expect(big().transferredBytes).toBe(SEG_MIN)
      })

      it('should split the rest when the one stream is slow, keeping the head on its first piece', async () => {
        await splitSlowHead()

        expect(server.events).toEqual(['seg 0', ...REST_STARTS.map((s) => `seg ${s}`)])
        headStall.resolve()
        await vi.waitFor(() => expect(big().status).toBe('completed'))

        const [head] = segmentClients()
        expect(head.downloadTo).toHaveBeenCalledTimes(1)
        // 머리는 CUT에서 끊겨 끝난다: 앞 구간처럼 성공이고 끊긴 클라이언트는 버린다
        expect(pool.discard).toHaveBeenCalledWith(head)
        expect(pool.releaseAfterError).not.toHaveBeenCalled()
        expect(fs.readFileSync(localPath).equals(source)).toBe(true)
        expect(big().transferredBytes).toBe(SEG_MIN)
        expect(big().retryCount).toBeUndefined()
      })

      it('should mark the file sparse on Windows before the one stream, so the split pieces write into it', async () => {
        // 분할한 조각은 머리 스트림보다 뒤쪽 오프셋에 먼저 쓰므로 WAN 분할과 같은 0 채우기를 겪는다
        setPlatform('win32')
        await splitSlowHead()
        headStall.resolve()
        await vi.waitFor(() => expect(big().status).toBe('completed'))

        expect(markSparse).toHaveBeenCalledTimes(1)
        expect(sizesAtMark).toEqual([0])
        expect(server.events).toEqual(['seg 0', ...REST_STARTS.map((s) => `seg ${s}`)])
        expect(fs.readFileSync(localPath).equals(source)).toBe(true)
      })

      it('should close the head client and unlink the file on cancel before the verdict', async () => {
        server.holds.set(0, deferred())
        const id = enqueueBig()
        await vi.waitFor(() => expect(big().transferredBytes).toBe(CHUNK))

        queue.cancel(id)
        await vi.waitFor(() => expect(unlink).toHaveBeenCalledWith(localPath))

        const [head] = segmentClients()
        expect(head.close).toHaveBeenCalled()
        expect(pool.discard).toHaveBeenCalledWith(head)
        expect(server.events).toEqual(['seg 0'])
        expect(big().status).toBe('cancelled')
      })

      it('should close every client and unlink the file on cancel after the split', async () => {
        for (const start of REST_STARTS) server.holds.set(start, deferred())
        const id = await splitSlowHead()

        queue.cancel(id)
        await vi.waitFor(() => expect(unlink).toHaveBeenCalledWith(localPath))

        const clients = segmentClients()
        expect(clients).toHaveLength(3)
        for (const client of clients) {
          expect(client.close).toHaveBeenCalled()
          expect(pool.discard).toHaveBeenCalledWith(client)
        }
        expect(big().status).toBe('cancelled')
      })

      it('should retry only [0, cut) when the head fails after the split', async () => {
        server.failures.set(0, Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
        await splitSlowHead()
        headStall.resolve()

        await vi.waitFor(() => expect(big().retryCount).toBe(1))
        await vi.advanceTimersByTimeAsync(2000)
        await vi.waitFor(() => expect(big().status).toBe('completed'))

        expect(server.events.filter((e) => e === 'seg 0')).toHaveLength(2)
        const retried = segmentClients().find(
          (c, i) => i > 0 && c.downloadTo.mock.calls[0]?.[2] === 0
        )!
        // 재시도한 머리는 CUT에서 끊겨 끝난다(최종 구간이면 226으로 끝나 풀에 돌려준다)
        expect(pool.discard).toHaveBeenCalledWith(retried)
        expect(fs.readFileSync(localPath).equals(source)).toBe(true)
        expect(big().transferredBytes).toBe(SEG_MIN)
      })

      it('should re-run one stream when the server ignores REST on the split ranges', async () => {
        server.ignoreRest = true
        await splitSlowHead()
        await vi.waitFor(() => expect(big().status).toBe('completed'))

        expect(pool.segmentedBroken).toBe(true)
        expect(mockFileOps.download).toHaveBeenCalledTimes(1)
        expect(big().retryCount).toBeUndefined()
        expect(big().transferredBytes).toBe(SEG_MIN)
      })
    })
  })

  describe('events', () => {
    it('should carry progress as transferredBytes in queue:updated upserts', async () => {
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(
        (
          _remote: string,
          _local: string,
          onProgress?: (info: { bytes: number; bytesOverall: number }) => void
        ) => {
          onProgress?.({ bytes: 512, bytesOverall: 512 })
          return new Promise(() => {})
        }
      )

      const listener = vi.fn()
      const legacyProgress = vi.fn()
      queue.on('queue:updated', listener)
      queue.on('transfer:progress', legacyProgress)

      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 1024)
      await vi.advanceTimersByTimeAsync(100)

      const update = listener.mock.calls.at(-1)![0] as TransferUpdate
      expect(update.upserts[0]).toMatchObject({ transferredBytes: 512, totalBytes: 1024 })
      expect(legacyProgress).not.toHaveBeenCalled()
    })
  })

  describe('throttled delta updates', () => {
    it('should coalesce 1000 jobs into at most one emit per flush interval', async () => {
      const listener = vi.fn()
      queue.on('queue:updated', listener)

      queue.enqueueBatch('download', items(1000))
      await vi.advanceTimersByTimeAsync(350)

      // 350ms 동안 100ms 주기라면 최대 4번(ceil(350/100))이다.
      expect(listener.mock.calls.length).toBeGreaterThan(0)
      expect(listener.mock.calls.length).toBeLessThanOrEqual(4)
      const seen = new Map<string, string>()
      for (const [update] of listener.mock.calls as [TransferUpdate][]) {
        for (const job of update.upserts) seen.set(job.id, job.status)
      }
      expect(seen.size).toBe(1000)
      expect([...seen.values()].every((status) => status === 'completed')).toBe(true)
    })

    it('should flush right away when the queue drains instead of waiting for the interval', async () => {
      const transfer = deferred()
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(() => transfer.promise)
      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 10)
      await vi.advanceTimersByTimeAsync(100)

      const listener = vi.fn()
      queue.on('queue:updated', listener)
      transfer.resolve()
      await settle()

      expect(listener).toHaveBeenCalledTimes(1)
      const update = listener.mock.calls[0][0] as TransferUpdate
      expect(update.upserts[0]).toMatchObject({ fileName: 'a.jpg', status: 'completed' })
      // 비운 뒤 남은 타이머가 빈 flush를 또 보내지 않는다
      await vi.advanceTimersByTimeAsync(1000)
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('should flush right away when the first job of an idle queue becomes active', async () => {
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {})
      )
      const listener = vi.fn()
      queue.on('queue:updated', listener)
      queue.enqueueBatch('download', items(2))
      await settle()

      // 첫 작업이 active가 되는 순간 나간다. 뒤따라 시작한 작업은 다음 주기에 합쳐진다.
      expect(listener).toHaveBeenCalledTimes(1)
      const update = listener.mock.calls[0][0] as TransferUpdate
      expect(update.upserts.map((job) => job.status)).toEqual(['active', 'pending'])

      // 이미 돌고 있는 큐에서는 평소처럼 주기에 맞춰 모은다
      queue.enqueue('download', '/local/x.jpg', '/remote/x.jpg', 'x.jpg', 10)
      await settle()
      expect(listener).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(100)
      expect(listener).toHaveBeenCalledTimes(2)
    })

    it('should include only jobs that changed since the last emit', async () => {
      queue.enqueueBatch('download', items(50))
      await vi.advanceTimersByTimeAsync(100)

      const listener = vi.fn()
      queue.on('queue:updated', listener)
      queue.enqueue('download', '/local/x.jpg', '/remote/x.jpg', 'x.jpg', 10)
      await vi.advanceTimersByTimeAsync(100)

      // x의 시작(active)과 완료가 각각 바로 나가고, 둘 다 x만 담는다
      expect(listener).toHaveBeenCalledTimes(2)
      for (const [update] of listener.mock.calls as [TransferUpdate][]) {
        expect(update.upserts.map((job) => job.fileName)).toEqual(['x.jpg'])
      }
    })

    it('should not emit when nothing changed', async () => {
      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 10)
      await vi.advanceTimersByTimeAsync(100)

      const listener = vi.fn()
      queue.on('queue:updated', listener)
      await vi.advanceTimersByTimeAsync(1000)

      expect(listener).not.toHaveBeenCalled()
    })

    it('should emit shallow copies so later mutations do not alter a sent update', async () => {
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {})
      )
      const listener = vi.fn()
      queue.on('queue:updated', listener)

      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 10)
      await vi.advanceTimersByTimeAsync(100)

      const sent = (listener.mock.calls[0][0] as TransferUpdate).upserts[0]
      expect(sent).not.toBe(queue.getAll()[0])
    })

    it('should report removed ids from clearCompleted and skip their pending upserts', async () => {
      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 10)
      await vi.advanceTimersByTimeAsync(100)
      const doneId = queue.getAll()[0].id
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {})
      )
      queue.enqueue('download', '/local/b.jpg', '/remote/b.jpg', 'b.jpg', 10)

      const listener = vi.fn()
      queue.on('queue:updated', listener)
      queue.clearCompleted()
      await vi.advanceTimersByTimeAsync(100)

      expect(listener).toHaveBeenCalledTimes(1)
      const update = listener.mock.calls[0][0] as TransferUpdate
      expect(update.removedIds).toEqual([doneId])
      expect(update.upserts.map((job) => job.fileName)).toEqual(['b.jpg'])
    })

    it('should not re-upsert a cleared job when a late progress tick arrives', async () => {
      let onProgress!: (info: { bytes: number; bytesOverall: number }) => void
      const transfer = deferred()
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(
        (_remote: string, _local: string, progress: typeof onProgress) => {
          onProgress = progress
          return transfer.promise
        }
      )
      const id = queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 10)
      await settle()
      queue.cancel(id)
      transfer.reject(new Error('User closed client during task'))
      await settle()
      queue.clearCompleted()
      await vi.advanceTimersByTimeAsync(100)

      const listener = vi.fn()
      queue.on('queue:updated', listener)
      onProgress({ bytes: 1, bytesOverall: 5 })
      await vi.advanceTimersByTimeAsync(100)

      // 렌더러가 지울 수 없는 행으로 다시 추가하지 않도록 아무것도 보내지 않는다
      expect(listener).not.toHaveBeenCalled()
    })

    it('should drop a job that was changed and cleared inside the same interval', async () => {
      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 10)
      await vi.advanceTimersByTimeAsync(0) // 완료되었지만 아직 flush 전
      const id = queue.getAll()[0].id

      const listener = vi.fn()
      queue.on('queue:updated', listener)
      queue.clearCompleted()
      await vi.advanceTimersByTimeAsync(100)

      const update = listener.mock.calls[0][0] as TransferUpdate
      expect(update.upserts).toEqual([])
      expect(update.removedIds).toEqual([id])
    })
  })
})
