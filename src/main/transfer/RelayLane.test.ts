import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import type { Readable, Writable } from 'stream'
import { ConnectionRegistry } from '../ftp/ConnectionRegistry'
import { fakeSession, payloadOf, remoteOf } from '../ftp/__fixtures__/fakeSessions'
import { FakeQueue } from '../mcp/__fixtures__/agentHarness'
import { MAX_RELAY_RUNNING } from './RelayLane'
import { TransferHub } from './TransferHub'
import type { BorrowedClient, TransferQueue } from './TransferQueue'
import type { Client } from 'basic-ftp'
import type { ConnKey } from '@shared/connKey'
import type { FtpMutationEvent } from '@shared/types/ftp'
import type { RelayEnqueueItem, TransferJob, TransferUpdate } from '@shared/types/transfer'

const A = 'a@a.example:21'
const B = 'b@b.example:21'

/** 재시도 가능한 연결 끊김(basic-ftp가 내는 소켓 오류와 같은 모양) */
const reset = (): Error => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
/** 재시도할 수 없는 권한 오류(FTP 550) */
const denied = (): Error => Object.assign(new Error('550 Permission denied'), { code: 550 })

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/**
 * basic-ftp 흉내. `downloadTo`는 정해 둔 조각을 쓰고 성공·실패 모두 `finally`에서 `end()`한다(§8-1).
 * `uploadFrom`은 끝까지 읽어 `stored`에 모으고 진행을 알린다. `close()`는 진행 중인 쪽을 거절시킨다.
 */
class FakeClient {
  closed = false
  private progress?: (info: { bytesOverall: number }) => void
  private abort?: (err: Error) => void
  sendIgnoringError = vi.fn(async (command: string) => ({ code: 257, message: `257 ${command}` }))

  constructor(private server: FakeServer) {}

  trackProgress(handler?: (info: { bytesOverall: number }) => void): void {
    this.progress = handler
  }

  close = vi.fn(() => {
    this.closed = true
    this.abort?.(reset())
  })

  private closing(): Promise<never> {
    return new Promise((_, reject) => (this.abort = reject))
  }

  async downloadTo(writable: Writable, path: string): Promise<void> {
    const plan = this.server.files[path]
    const work = (async (): Promise<void> => {
      for (const step of plan.steps) {
        if (step instanceof Promise) await step
        else await new Promise<void>((done) => writable.write(step, () => done()))
      }
      if (plan.error) throw plan.error()
    })()
    try {
      await Promise.race([work, this.closing()])
    } catch (err) {
      // basic-ftp처럼 실패해도 대상을 end()한다. 받는 쪽이 그 EOF를 먼저 볼 수 있게 거절을 한 박자 늦춘다
      writable.end()
      await new Promise((later) => setTimeout(later, 0))
      throw err
    }
    writable.end()
  }

  async uploadFrom(readable: Readable, path: string): Promise<void> {
    this.server.stors.push(path)
    if (this.server.storError) throw this.server.storError()
    const chunks: Buffer[] = []
    let bytes = 0
    const read = (async (): Promise<void> => {
      for await (const chunk of readable) {
        chunks.push(chunk as Buffer)
        bytes += (chunk as Buffer).length
        this.progress?.({ bytesOverall: bytes })
      }
    })()
    await Promise.race([read, this.closing()])
    this.server.stored[path] = Buffer.concat(chunks)
  }
}

/** 한 서버(보내는 쪽 파일, 받는 쪽 저장)와 그 세션 큐의 슬롯 빌림 */
class FakeServer extends FakeQueue {
  files: Record<string, { steps: Array<Buffer | Promise<void>>; error?: () => Error }> = {}
  stored: Record<string, Buffer> = {}
  stors: string[] = []
  storError?: () => Error
  clients: FakeClient[] = []
  /** null이면 보조 연결 불가(MC28) */
  lendNull = false
  limit = Infinity
  inUse = 0
  waiters: Array<() => void> = []
  leases: Array<BorrowedClient & { done: ReturnType<typeof vi.fn> }> = []

  constructor(
    readonly key: ConnKey,
    readonly log: ConnKey[]
  ) {
    super(key)
  }

  borrow = vi.fn((signal?: AbortSignal): Promise<BorrowedClient | null> => {
    this.log.push(this.key)
    if (this.lendNull) return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      const take = (): void => {
        this.inUse++
        const client = new FakeClient(this)
        this.clients.push(client)
        const lease = {
          client: client as unknown as Client,
          done: vi.fn(() => {
            this.inUse--
            this.waiters.shift()?.()
          })
        }
        this.leases.push(lease)
        resolve(lease)
      }
      if (this.inUse < this.limit) return take()
      const wait = (): void => take()
      this.waiters.push(wait)
      signal?.addEventListener('abort', () => {
        this.waiters = this.waiters.filter((w) => w !== wait)
        reject(new Error('Cancelled'))
      })
    })
  })
}

let registry: ConnectionRegistry
let hub: TransferHub
let servers: Record<ConnKey, FakeServer>
let log: ConnKey[]
let updates: TransferUpdate[]

beforeEach(async () => {
  vi.useFakeTimers()
  log = []
  servers = { [A]: new FakeServer(A, log), [B]: new FakeServer(B, log) }
  registry = new ConnectionRegistry((key) =>
    fakeSession(key, { queue: servers[key] as unknown as TransferQueue })
  )
  hub = new TransferHub(registry)
  updates = []
  hub.on('queue:updated', (update: TransferUpdate) => updates.push(update))
  await registry.connect(payloadOf(A))
  await registry.connect(payloadOf(B))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => undefined)
const relays = (): TransferJob[] => hub.getAll().filter((job) => job.direction === 'relay')
const jobOf = (id: string): TransferJob => hub.getAll().find((job) => job.id === id)!
const remote = (key: ConnKey): ReturnType<typeof remoteOf> => remoteOf(registry.get(key))
const mutations = (key: ConnKey): FtpMutationEvent[] => {
  const seen: FtpMutationEvent[] = []
  remote(key).on('mutation', (event: FtpMutationEvent) => seen.push(event))
  return seen
}

function item(name: string, size: number, dir = '/in'): RelayEnqueueItem {
  return {
    sourcePath: `/src/${name}`,
    remotePath: `${dir}/${name}`,
    fileName: name,
    totalBytes: size
  }
}

/** 보내는 쪽 파일. 조각 사이에 `hold`를 넣으면 테스트가 풀 때까지 멈춘다. */
function file(
  server: ConnKey,
  name: string,
  steps: Array<string | Promise<void>>,
  error?: () => Error
): void {
  servers[server].files[`/src/${name}`] = {
    steps: steps.map((s) => (typeof s === 'string' ? Buffer.from(s) : s)),
    error
  }
}

describe('RelayLane', () => {
  it('streams the source bytes into the target, tracks the receiving progress and never touches local files', async () => {
    // covers: Test-984
    const spies = [
      vi.spyOn(fsp, 'open'),
      vi.spyOn(fsp, 'writeFile'),
      vi.spyOn(fs, 'createWriteStream'),
      vi.spyOn(fs, 'writeFile'),
      vi.spyOn(fs, 'open')
    ]
    const hold = deferred()
    file(A, 'a.bin', ['abc', hold.promise, 'defgh'])
    const [id] = hub.enqueueRelay(A, B, [item('a.bin', 8)], [])
    await settle()

    expect(jobOf(id)).toMatchObject({ status: 'active', transferredBytes: 3 })
    hold.resolve()
    await settle()

    expect(servers[B].stored['/in/a.bin'].toString()).toBe('abcdefgh')
    expect(jobOf(id)).toMatchObject({ status: 'completed', transferredBytes: 8 })
    for (const server of [A, B]) {
      expect(servers[server].leases).toHaveLength(1)
      expect(servers[server].leases[0].done.mock.calls).toEqual([[undefined]])
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('borrows in ascending key order so opposite copies on one-slot servers both finish', async () => {
    // covers: Test-985
    file(A, 'ab.bin', ['ab'])
    file(B, 'ba.bin', ['ba'])
    // 한 작업씩: 방향과 무관하게 A가 먼저
    hub.enqueueRelay(A, B, [item('ab.bin', 2)], [])
    await settle()
    hub.enqueueRelay(B, A, [item('ba.bin', 2)], [])
    await settle()
    expect(log).toEqual([A, B, A, B])

    // 양쪽 한도 1에서 반대 방향 둘을 함께
    servers[A].limit = 1
    servers[B].limit = 1
    const [ab] = hub.enqueueRelay(A, B, [item('ab.bin', 2)], [])
    const [ba] = hub.enqueueRelay(B, A, [item('ba.bin', 2)], [])
    await settle()

    expect(jobOf(ab).status).toBe('completed')
    expect(jobOf(ba).status).toBe('completed')
    expect(servers[A].stored['/in/ba.bin'].toString()).toBe('ba')
  })

  it('does not finish a truncated upload when the source fails, and retries from zero', async () => {
    // covers: Test-986
    let attempts = 0
    servers[A].files['/src/a.bin'] = {
      get steps() {
        attempts++
        return [Buffer.from('half')]
      },
      error: reset
    }
    const [id] = hub.enqueueRelay(A, B, [item('a.bin', 8)], [])
    await settle()

    expect(servers[B].stored['/in/a.bin']).toBeUndefined()
    expect(jobOf(id)).toMatchObject({ status: 'pending', transferredBytes: 0, retryCount: 1 })
    expect(jobOf(id).error).toMatch(new RegExp(`^Retry 1/3: ${A}: `))

    await vi.advanceTimersByTimeAsync(2000 * 3 + 10)
    expect(attempts).toBe(4)
    expect(servers[B].stors).toEqual(Array(4).fill('/in/a.bin'))
    expect(servers[B].stored['/in/a.bin']).toBeUndefined()
    expect(jobOf(id).status).toBe('failed')
    expect(jobOf(id).error!.startsWith(`${A}: `)).toBe(true)
  })

  it('closes the source when the target refuses the upload and fails at once', async () => {
    // covers: Test-987
    const hold = deferred()
    file(A, 'a.bin', ['ab', hold.promise, 'cd'])
    servers[B].storError = denied
    const [id] = hub.enqueueRelay(A, B, [item('a.bin', 4)], [])
    await settle()

    expect(servers[A].clients[0].close).toHaveBeenCalled()
    expect(jobOf(id).status).toBe('failed')
    expect(jobOf(id).error!.startsWith(`${B}: `)).toBe(true)
    expect(jobOf(id).retryCount).toBeUndefined()
    for (const server of [A, B]) {
      expect(servers[server].leases[0].done).toHaveBeenCalledWith(expect.any(Error))
    }
  })

  it('removes the partial target file after a final failure or an active cancel, and only then', async () => {
    // covers: Test-988
    remote(B).addDir('/in').addFile('/in/fail.bin').addFile('/in/cut.bin')
    // 최종 실패: 3번 재시도 사이에는 지우지 않고, 마지막 실패 뒤 한 번
    file(A, 'fail.bin', ['part'], reset)
    const [failed] = hub.enqueueRelay(A, B, [item('fail.bin', 8)], [])
    await settle()
    await vi.advanceTimersByTimeAsync(2000 * 2)
    expect(remote(B).deleteFile).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000 + 10)
    expect(jobOf(failed).status).toBe('failed')
    expect(remote(B).deleteFile.mock.calls).toEqual([['/in/fail.bin']])
    expect(jobOf(failed).partialRemoved).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    const sent = updates.flatMap((u) => u.upserts).filter((j) => j.id === failed)
    expect(sent.at(-1)?.partialRemoved).toBe(true)

    // 실행 중 취소
    const hold = deferred()
    file(A, 'cut.bin', ['abc', hold.promise])
    const [cut] = hub.enqueueRelay(A, B, [item('cut.bin', 8)], [])
    await settle()
    hub.cancel(cut)
    await settle()
    expect(jobOf(cut)).toMatchObject({ status: 'cancelled', partialRemoved: true })
    expect(remote(B).deleteFile).toHaveBeenCalledTimes(2)

    // 0바이트 실패, 대기 중 취소, 보조 연결 불가는 아무것도 지우지 않는다
    servers[B].storError = denied
    file(A, 'zero.bin', ['data'])
    const [zero] = hub.enqueueRelay(A, B, [item('zero.bin', 4)], [])
    await settle()
    servers[B].storError = undefined
    servers[A].limit = 0
    const [waiting] = hub.enqueueRelay(A, B, [item('wait.bin', 4)], [])
    await settle()
    hub.cancel(waiting)
    await settle()
    servers[A].limit = Infinity
    servers[B].lendNull = true
    const [single] = hub.enqueueRelay(A, B, [item('single.bin', 4)], [])
    await settle()
    expect([zero, waiting, single].map((id) => jobOf(id).status)).toEqual([
      'failed',
      'cancelled',
      'failed'
    ])
    expect([zero, waiting, single].map((id) => jobOf(id).partialRemoved)).toEqual([
      undefined,
      undefined,
      undefined
    ])
    expect(remote(B).deleteFile).toHaveBeenCalledTimes(2)

    // 지우기가 거절하면 표시 없이 오류에 적는다
    servers[B].lendNull = false
    servers[B].storError = undefined
    file(A, 'gone.bin', ['xy'], denied)
    const [gone] = hub.enqueueRelay(A, B, [item('gone.bin', 4)], [])
    await settle()
    expect(remote(B).deleteFile).toHaveBeenCalledTimes(3)
    expect(jobOf(gone).partialRemoved).toBeUndefined()
    expect(jobOf(gone).error).toBe(
      `${A}: Permission denied or file/directory not found. (partial file left on ${B})`
    )
  })

  it('withdraws a waiting borrow on a pending cancel and closes both clients on an active cancel', async () => {
    // covers: Test-989
    servers[A].limit = MAX_RELAY_RUNNING
    const holds = Array.from({ length: MAX_RELAY_RUNNING }, () => deferred())
    holds.forEach((hold, i) => file(A, `r${i}.bin`, ['x', hold.promise]))
    const running = hub.enqueueRelay(
      A,
      B,
      holds.map((_, i) => item(`r${i}.bin`, 2)),
      []
    )
    // 레인이 꽉 차 시작하지 않은 작업: 빌림 0회
    const [queued] = hub.enqueueRelay(A, B, [item('q.bin', 1)], [])
    await settle()
    const borrows = log.length
    hub.cancel(queued)
    await settle()
    expect(jobOf(queued).status).toBe('cancelled')
    expect(log).toHaveLength(borrows)

    // 슬롯을 기다리는 중인 작업: 줄 선 빌림을 거둔다
    servers[A].limit = 0
    holds[0].resolve()
    await settle()
    const [blocked] = hub.enqueueRelay(A, B, [item('b.bin', 1)], [])
    await settle()
    expect(servers[A].waiters).toHaveLength(1)
    hub.cancel(blocked)
    await settle()
    expect(servers[A].waiters).toHaveLength(0)
    expect(jobOf(blocked).status).toBe('cancelled')

    // 실행 중 취소: 두 클라이언트를 닫고 다시 시도하지 않는다
    const active = running[1]
    const a = servers[A].clients[1]
    const b = servers[B].clients[1]
    hub.cancel(active)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(a.close).toHaveBeenCalled()
    expect(b.close).toHaveBeenCalled()
    expect(jobOf(active)).toMatchObject({ status: 'cancelled' })
    expect(jobOf(active).retryCount).toBeUndefined()
    expect(servers[A].leases[1].done).toHaveBeenCalledWith(expect.any(Error))
    expect(servers[B].leases[1].done).toHaveBeenCalledWith(expect.any(Error))
  })

  it('retries a failed job with the same id and batch from zero and sends the folder MKDs again', async () => {
    // covers: Test-990
    // 받는 쪽에 일부를 보낸 뒤 실패해 정리 표시가 붙은 작업
    remote(B).addDir('/in').addDir('/in/sub').addFile('/in/sub/a.bin')
    file(A, 'a.bin', ['da'], denied)
    const [id] = hub.enqueueRelay(A, B, [item('a.bin', 4, '/in/sub')], ['/in/sub'])
    await settle()
    const first = { ...jobOf(id) }
    expect(first).toMatchObject({ status: 'failed', partialRemoved: true })
    expect(servers[B].clients[0].sendIgnoringError.mock.calls).toEqual([['MKD /in/sub']])

    file(A, 'a.bin', ['data'])
    hub.retry([id])
    const retried = jobOf(id)
    expect(retried).toMatchObject({ id, batchId: first.batchId, status: 'pending' })
    expect(retried.error).toBeUndefined()
    expect(retried.retryCount).toBeUndefined()
    expect(retried.startedAt).toBeUndefined()
    expect(retried.partialRemoved).toBeUndefined()
    await settle()

    expect(servers[B].clients[1].sendIgnoringError.mock.calls).toEqual([['MKD /in/sub']])
    expect(servers[B].stored['/in/sub/a.bin'].toString()).toBe('data')
    expect(jobOf(id)).toMatchObject({ id, status: 'completed', transferredBytes: 4 })
  })

  it('fails at once without retrying when a side lends no secondary connection', async () => {
    // covers: Test-991
    servers[B].lendNull = true
    file(A, 'a.bin', ['data'])
    const [id] = hub.enqueueRelay(A, B, [item('a.bin', 4)], [])
    await settle()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(jobOf(id).status).toBe('failed')
    expect(jobOf(id).error).toBe(
      `${B} allows only one connection, so a server-to-server copy can't run. ` +
        'Download the files, then upload them.'
    )
    expect(log).toEqual([A, B])
    expect(servers[A].leases[0].done.mock.calls).toEqual([[]])
  })

  it('ends up failed when the receiving session drops mid-transfer', async () => {
    // covers: Test-992
    const hold = deferred()
    file(A, 'a.bin', ['abc', hold.promise])
    const [id] = hub.enqueueRelay(A, B, [item('a.bin', 6)], [])
    await settle()
    expect(jobOf(id).status).toBe('active')

    // 받는 쪽 연결이 끊기면 풀이 클라이언트를 닫고, 그 뒤의 빌림은 거절된다
    const dst = remote(B)
    dst.connected = false
    dst.setStatus('disconnected')
    servers[B].clients[0].close()
    servers[B].borrow.mockRejectedValue(new Error('Not connected'))
    await vi.advanceTimersByTimeAsync(2000 * 4)

    expect(jobOf(id).status).toBe('failed')
    expect(relays().some((job) => job.status === 'active' || job.status === 'pending')).toBe(false)
  })

  it('runs at most MAX_RELAY_RUNNING copies at once and starts the next when one ends', async () => {
    // covers: Test-993
    const holds = Array.from({ length: 10 }, () => deferred())
    holds.forEach((hold, i) => file(A, `f${i}.bin`, ['x', hold.promise]))
    hub.enqueueRelay(
      A,
      B,
      holds.map((_, i) => item(`f${i}.bin`, 1)),
      []
    )
    await settle()
    const active = (): number => relays().filter((job) => job.status === 'active').length

    expect(MAX_RELAY_RUNNING).toBe(4)
    expect(active()).toBe(4)
    holds[0].resolve()
    await settle()
    expect(active()).toBe(4)
    expect(relays().filter((job) => job.status === 'completed')).toHaveLength(1)
    expect(relays()[4].status).toBe('active')
  })

  it('tells only the receiving session about a finished copy', async () => {
    // covers: Test-1030
    const toA = mutations(A)
    const toB = mutations(B)
    file(A, 'ok.bin', ['ok'])
    hub.enqueueRelay(A, B, [item('ok.bin', 2)], [])
    await settle()
    expect(toB).toEqual([{ kind: 'upload', remotePath: '/in/ok.bin' }])
    expect(toA).toEqual([])

    // 재시도 불가 실패와 대기 중 취소는 upload를 알리지 않는다
    file(A, 'bad.bin', ['x'], denied)
    hub.enqueueRelay(A, B, [item('bad.bin', 2)], [])
    servers[A].limit = 0
    const [waiting] = hub.enqueueRelay(A, B, [item('wait.bin', 2)], [])
    await settle()
    hub.cancel(waiting)
    await settle()
    expect(toB.filter((event) => event.kind === 'upload')).toHaveLength(1)
    expect(toA).toEqual([])
  })
})
