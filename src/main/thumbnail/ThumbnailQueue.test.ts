import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Writable } from 'stream'
import { ThumbnailQueue, type ThumbnailRequest } from './ThumbnailQueue'
import { generateCacheKey } from '../utils/cacheKey'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import type { ThumbnailGenerator } from './ThumbnailGenerator'
import type { CacheManager } from './CacheManager'

const HOST = 'example.org'
const PORT = 21
const MODIFIED_AT = '2024-05-01T10:20:30.000Z'

function remotePath(i: number): string {
  return `/photos/img${String(i).padStart(3, '0')}.jpg`
}

function req(i: number, priority = 0): ThumbnailRequest {
  return {
    remotePath: remotePath(i),
    fileName: `img${i}.jpg`,
    fileSize: 1000,
    modifiedAt: MODIFIED_AT,
    priority
  }
}

function keyOf(i: number): string {
  return generateCacheKey(HOST, PORT, remotePath(i), 1000, MODIFIED_AT)
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, k) => from + k)
}

/** 큐 안의 async 단계(연결·다운로드·생성)가 모두 진행되도록 매크로태스크를 몇 번 넘긴다. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

interface Download {
  finish: () => void
  fail: (err: Error) => void
}

/**
 * 가짜 보조 FTP 클라이언트. `downloadTo`는 시작한 경로를 기록하고 테스트가 `finish`할 때까지 대기한다.
 * `close`는 진행 중 다운로드를 실제 basic-ftp처럼 에러로 끝낸다.
 */
interface Harness {
  queue: ThumbnailQueue
  /** 다운로드가 시작된 원격 경로(시작 순서) */
  started: string[]
  counts: { created: number; closed: number }
  onReady: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
  drain: () => Promise<void>
  finish: (path: string) => Promise<void>
  fail: (path: string) => Promise<void>
  releaseConnect: () => void
}

function createHarness(options: { holdFirstConnect?: boolean } = {}): Harness {
  const started: string[] = []
  const downloads = new Map<string, Download>()
  const counts = { created: 0, closed: 0 }
  let releaseConnect: (() => void) | null = null

  function makeClient(): { downloadTo: unknown; close: () => void } {
    const pending = new Set<(err: Error) => void>()
    return {
      downloadTo: (writable: Writable, path: string) =>
        new Promise<void>((resolve, reject) => {
          started.push(path)
          const fail = (err: Error): void => {
            pending.delete(fail)
            downloads.delete(path)
            reject(err)
          }
          pending.add(fail)
          downloads.set(path, {
            finish: () => {
              pending.delete(fail)
              downloads.delete(path)
              writable.write(Buffer.from('img'))
              resolve()
            },
            fail
          })
        }),
      close: () => {
        counts.closed++
        for (const fail of [...pending]) fail(new Error('Client is closed'))
      }
    }
  }

  const ftp = {
    getHost: () => HOST,
    getPort: () => PORT,
    createSecondaryClient: vi.fn(async () => {
      counts.created++
      if (options.holdFirstConnect && counts.created === 1) {
        await new Promise<void>((resolve) => {
          releaseConnect = resolve
        })
      }
      return makeClient()
    }),
    runOnMainClient: vi.fn()
  }
  const generator = {
    getFormat: vi.fn(async () => 'jpeg'),
    generate: vi.fn(async () => ({
      buffer: Buffer.from('thumb'),
      width: 10,
      height: 10,
      format: 'jpeg'
    }))
  }
  const cache = { lookup: vi.fn(() => undefined), store: vi.fn(), readThumbnail: vi.fn() }
  const onReady = vi.fn()
  const onError = vi.fn()
  const queue = new ThumbnailQueue(
    ftp as unknown as FtpConnectionManager,
    generator as unknown as ThumbnailGenerator,
    cache as unknown as CacheManager,
    onReady,
    onError
  )

  /** 진행 중인 다운로드를 시작 순서대로 하나씩 끝내, 큐가 빌 때까지 돌린다. */
  async function drain(): Promise<void> {
    await flush()
    while (downloads.size > 0) {
      const [first] = downloads.values()
      first.finish()
      await flush()
    }
  }

  async function finish(path: string): Promise<void> {
    downloads.get(path)?.finish()
    await flush()
  }

  async function fail(path: string): Promise<void> {
    downloads.get(path)?.fail(new Error('550 Permission denied'))
    await flush()
  }

  return {
    queue,
    started,
    counts,
    onReady,
    onError,
    drain,
    finish,
    fail,
    releaseConnect: (): void => releaseConnect?.()
  }
}

let current: Harness | null = null

function harness(options?: { holdFirstConnect?: boolean }): Harness {
  current = createHarness(options)
  return current
}

afterEach(() => {
  // 남은 다운로드의 30초 타이머를 정리한다(close가 진행 중 다운로드를 끝낸다).
  current?.queue.cancelAll()
  current = null
})

describe('ThumbnailQueue.requestBatch — viewport batch replaces the previous one', () => {
  it('serves the new viewport next and never starts the old viewport’s waiting items', async () => {
    // covers: Test-262
    const h = harness()
    h.queue.requestBatch(range(0, 50).map((i) => req(i)))
    await flush()
    expect(h.started).toEqual([0, 1, 2].map(remotePath))

    h.queue.requestBatch(range(500, 530).map((i) => req(i)))
    await h.drain()

    expect(h.started.slice(3)).toEqual(range(500, 530).map(remotePath))
    expect(h.started).toHaveLength(33)
  })

  it('lets in-flight downloads of the old viewport finish and reuses their connections', async () => {
    // covers: Test-263
    const h = harness()
    h.queue.requestBatch(range(0, 50).map((i) => req(i)))
    await flush()

    h.queue.requestBatch(range(500, 530).map((i) => req(i)))
    for (const i of [0, 1, 2]) await h.finish(remotePath(i))

    const readyKeys = h.onReady.mock.calls.map((call) => call[0].cacheKey)
    expect(readyKeys).toEqual([keyOf(0), keyOf(1), keyOf(2)])
    expect(h.counts.created).toBe(3)
    expect(h.counts.closed).toBe(0)
    // 풀린 연결로 새 뷰포트 항목이 이어서 시작됐다.
    expect(h.started.slice(3)).toEqual([500, 501, 502].map(remotePath))
  })

  it('starts the lowest priority first whatever order the batch arrives in', async () => {
    // covers: Test-264
    const h = harness()
    h.queue.requestBatch([req(10, 2), req(11, 1), req(12, 0), req(13, 0), req(14, 1)])
    await h.drain()

    expect(h.started).toEqual([12, 13, 11, 14, 10].map(remotePath))
  })

  it('re-sorts an item still waiting from the previous batch by its new priority', async () => {
    // covers: Test-265
    const h = harness()
    h.queue.requestBatch([req(0), req(1), req(2), req(3, 1), req(4, 3)])
    await flush()

    // 3은 이번 창에 없어 버려지고, 4는 priority 3 → 0으로 당겨져 새 항목 5(priority 1)보다 먼저 시작한다.
    h.queue.requestBatch([req(0), req(1), req(2), req(5, 1), req(4, 0)])
    await h.drain()

    expect(h.started).toEqual([0, 1, 2, 4, 5].map(remotePath))
  })

  it('keeps single request() items that the batch does not contain', async () => {
    // covers: Test-266
    const h = harness()
    h.queue.requestBatch([req(0), req(1), req(2)])
    await flush()
    h.queue.request(req(900, 1))

    h.queue.requestBatch([req(10), req(11)])
    await h.drain()

    expect(h.started).toEqual([0, 1, 2, 10, 11, 900].map(remotePath))
  })

  it('downloads an item again when a later batch brings it back', async () => {
    // covers: Test-267
    const h = harness()
    h.queue.requestBatch(range(0, 6).map((i) => req(i)))
    await flush()

    h.queue.requestBatch([req(10)])
    h.queue.requestBatch([req(10), req(3)])
    await h.drain()

    expect(h.started).toEqual([0, 1, 2, 10, 3].map(remotePath))
  })

  it('drops every waiting item of the previous batch on an empty batch', async () => {
    // covers: Test-268
    const h = harness()
    h.queue.requestBatch(range(0, 6).map((i) => req(i)))
    await flush()

    h.queue.requestBatch([])
    await h.drain()

    expect(h.started).toEqual([0, 1, 2].map(remotePath))
  })
})

describe('ThumbnailQueue.cancelAll — cancelled work leaves nothing behind', () => {
  it('closes a secondary connection that finishes connecting after cancelAll', async () => {
    // covers: Test-269
    const h = harness({ holdFirstConnect: true })
    h.queue.request(req(0))
    await flush()

    h.queue.cancelAll()
    h.releaseConnect()
    await flush()

    expect(h.counts.closed).toBe(1)
    expect(h.started).toEqual([])

    // 닫은 연결을 재사용하지 않고 새로 연다.
    h.queue.request(req(1))
    await flush()
    expect(h.counts.created).toBe(2)
    expect(h.started).toEqual([remotePath(1)])
  })

  it('does not report an error for a download cancelled by cancelAll', async () => {
    // covers: Test-270
    const h = harness()
    h.queue.request(req(0))
    await flush()
    expect(h.started).toEqual([remotePath(0)])

    // 디렉터리 이동: 취소 직후 새 폴더의 요청이 들어온다(예전에는 이 요청이 전역 aborted를 되돌렸다).
    h.queue.cancelAll()
    h.queue.request(req(1))
    await flush()

    expect(h.onError).not.toHaveBeenCalled()
    expect(h.started).toEqual([remotePath(0), remotePath(1)])

    // 대조군: 취소되지 않은 다운로드의 실패는 그대로 보고한다. 이게 없으면 에러를 아예 안 보내는 구현도 통과한다.
    await h.fail(remotePath(1))
    expect(h.onError.mock.calls).toEqual([[keyOf(1), '550 Permission denied']])
  })
})
