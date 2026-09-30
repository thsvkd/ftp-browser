import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { FTPError, type Client } from 'basic-ftp'
import {
  TransferClientPool,
  LIMIT,
  MAX_TRANSFER_CLIENTS,
  POOL_IDLE_CLOSE_MS,
  RECENT_CLOSE_MS,
  LOGIN_RETRY_DELAY_MS
} from './TransferClientPool'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'

interface FakeClient {
  closed: boolean
  close: ReturnType<typeof vi.fn>
}

function createFakeClient(): FakeClient {
  const c: FakeClient = {
    closed: false,
    close: vi.fn(() => {
      c.closed = true
    })
  }
  return c
}

type MockManager = EventEmitter & {
  createSecondaryClient: ReturnType<typeof vi.fn>
  runOnMainClient: ReturnType<typeof vi.fn>
  getMaxTransfers: ReturnType<typeof vi.fn>
}

function createMockManager(): MockManager {
  const m = new EventEmitter() as MockManager
  m.createSecondaryClient = vi.fn(async () => createFakeClient())
  m.runOnMainClient = vi.fn()
  m.getMaxTransfers = vi.fn(() => MAX_TRANSFER_CLIENTS)
  return m
}

const asClient = (c: FakeClient): Client => c as unknown as Client

describe('TransferClientPool', () => {
  let manager: MockManager
  let pool: TransferClientPool

  beforeEach(() => {
    manager = createMockManager()
    pool = new TransferClientPool(manager as unknown as FtpConnectionManager)
  })

  afterEach(() => {
    pool.dispose()
    vi.useRealTimers()
  })

  async function acquireClient(): Promise<FakeClient> {
    const c = await pool.acquire()
    expect(c).not.toBeNull()
    expect(c).not.toBe(LIMIT)
    return c as unknown as FakeClient
  }

  describe('creation and reuse', () => {
    it('does not create a client until the first acquire', () => {
      expect(manager.createSecondaryClient).not.toHaveBeenCalled()
      expect(pool.limit).toBe(MAX_TRANSFER_CLIENTS)
    })

    it('creates a client lazily on acquire and tracks it as in use', async () => {
      await acquireClient()
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(1)
      expect(pool.inUseCount).toBe(1)
      expect(pool.idleCount).toBe(0)
    })

    it('reuses a released client instead of creating a new one', async () => {
      const a = await acquireClient()
      pool.release(asClient(a))
      expect(pool.idleCount).toBe(1)
      expect(pool.inUseCount).toBe(0)

      const b = await acquireClient()
      expect(b).toBe(a)
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(1)
    })

    it('skips an idle client that the server closed and creates a new one', async () => {
      const a = await acquireClient()
      pool.release(asClient(a))
      a.closed = true

      const b = await acquireClient()
      expect(b).not.toBe(a)
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(2)
      expect(pool.idleCount).toBe(0)
    })

    it('discard closes the client and drops it from the pool', async () => {
      const a = await acquireClient()
      pool.discard(asClient(a))
      expect(a.close).toHaveBeenCalledTimes(1)
      expect(pool.inUseCount).toBe(0)
      expect(pool.idleCount).toBe(0)
    })

    it('discard of a client that is already idle removes it from idle', async () => {
      const a = await acquireClient()
      pool.release(asClient(a))
      pool.discard(asClient(a))
      expect(a.close).toHaveBeenCalledTimes(1)
      expect(pool.idleCount).toBe(0)
    })

    it('closes a released client that is already closed instead of keeping it idle', async () => {
      const a = await acquireClient()
      a.closed = true
      pool.release(asClient(a))
      expect(pool.idleCount).toBe(0)
      expect(pool.inUseCount).toBe(0)
    })

    it('closes a client that was never issued by this pool when released', () => {
      const stranger = createFakeClient()
      pool.release(asClient(stranger))
      expect(stranger.close).toHaveBeenCalled()
      expect(pool.idleCount).toBe(0)
    })

    it('returns LIMIT instead of creating a client beyond the limit', async () => {
      for (let i = 0; i < MAX_TRANSFER_CLIENTS; i++) await acquireClient()
      expect(await pool.acquire()).toBe(LIMIT)
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(MAX_TRANSFER_CLIENTS)
      expect(pool.limit).toBe(MAX_TRANSFER_CLIENTS)
    })

    it('counts connecting clients toward the limit', async () => {
      const pending: Array<(c: FakeClient) => void> = []
      manager.createSecondaryClient.mockImplementation(
        () => new Promise<FakeClient>((resolve) => pending.push(resolve))
      )
      const p = Array.from({ length: MAX_TRANSFER_CLIENTS }, () => pool.acquire())
      expect(pool.connectingCount).toBe(MAX_TRANSFER_CLIENTS)
      expect(await pool.acquire()).toBe(LIMIT)
      pending.forEach((r) => r(createFakeClient()))
      await Promise.all(p)
      expect(pool.connectingCount).toBe(0)
      expect(pool.inUseCount).toBe(MAX_TRANSFER_CLIENTS)
    })
  })

  describe('configured limit', () => {
    it('defaults to 16', () => {
      expect(MAX_TRANSFER_CLIENTS).toBe(16)
    })

    it('starts at the limit the connection config allows', async () => {
      manager.getMaxTransfers.mockReturnValue(3)
      const small = new TransferClientPool(manager as unknown as FtpConnectionManager)
      expect(small.limit).toBe(3)
      for (let i = 0; i < 3; i++) expect(await small.acquire()).not.toBe(LIMIT)
      expect(await small.acquire()).toBe(LIMIT)
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(3)
      small.dispose()
    })

    it('reads the new connection config once the login has finished', () => {
      manager.emit('connectionStatus', { status: 'connecting' })
      manager.getMaxTransfers.mockReturnValue(20)
      manager.emit('connectionStatus', { status: 'connected' })
      expect(pool.limit).toBe(20)

      manager.emit('connectionStatus', { status: 'disconnected' })
      manager.getMaxTransfers.mockReturnValue(1)
      manager.emit('connectionStatus', { status: 'connected' })
      expect(pool.limit).toBe(1)
    })

    it('goes back to the configured limit, not the default, after an adaptive shrink and idle close', async () => {
      vi.useFakeTimers()
      manager.getMaxTransfers.mockReturnValue(8)
      manager.emit('connectionStatus', { status: 'connected' })
      const a = await acquireClient()
      manager.createSecondaryClient.mockRejectedValueOnce(
        new FTPError({ code: 421, message: '421 x' })
      )
      expect(await pool.acquire()).toBe(LIMIT)
      expect(pool.limit).toBe(1)

      pool.release(asClient(a))
      pool.armIdleClose()
      await vi.advanceTimersByTimeAsync(POOL_IDLE_CLOSE_MS)
      expect(pool.limit).toBe(8)
    })

    it('returns LIMIT once the configured number of clients are open', async () => {
      manager.getMaxTransfers.mockReturnValue(4)
      manager.emit('connectionStatus', { status: 'connected' })
      for (let i = 0; i < 4; i++) await acquireClient()
      expect(await pool.acquire()).toBe(LIMIT)
      expect(pool.limit).toBe(4)
    })
  })

  describe('releaseAfterError', () => {
    it('releases the client on an FTPError while the connection is alive', async () => {
      const a = await acquireClient()
      pool.releaseAfterError(asClient(a), new FTPError({ code: 550, message: '550 No such file' }))
      expect(pool.idleCount).toBe(1)
      expect(a.close).not.toHaveBeenCalled()
    })

    it('discards the client on an FTPError when the client is already closed', async () => {
      const a = await acquireClient()
      a.closed = true
      pool.releaseAfterError(asClient(a), new FTPError({ code: 550, message: '550 x' }))
      expect(pool.idleCount).toBe(0)
      expect(pool.inUseCount).toBe(0)
    })

    it('discards the client on a non-FTPError', async () => {
      const a = await acquireClient()
      pool.releaseAfterError(asClient(a), new Error('socket hang up'))
      expect(a.close).toHaveBeenCalled()
      expect(pool.idleCount).toBe(0)
      expect(pool.inUseCount).toBe(0)
    })
  })

  describe('too-many-connections shrink', () => {
    it('421 on the 5th create while 4 are open sets limit to 4 and signals LIMIT', async () => {
      for (let i = 0; i < 4; i++) await acquireClient()
      manager.createSecondaryClient.mockRejectedValueOnce(
        new FTPError({ code: 421, message: '421 Too many connections' })
      )

      expect(await pool.acquire()).toBe(LIMIT)
      expect(pool.limit).toBe(4)
      // 이후 acquire는 서버를 다시 두드리지 않고 LIMIT를 돌려준다
      expect(await pool.acquire()).toBe(LIMIT)
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(5)
    })

    it('counts other in-flight connects as open when shrinking', async () => {
      let resolveSecond: (c: FakeClient) => void = () => {}
      manager.createSecondaryClient
        .mockRejectedValueOnce(new FTPError({ code: 421, message: '421 x' }))
        .mockImplementationOnce(
          () => new Promise<FakeClient>((resolve) => (resolveSecond = resolve))
        )
      const first = pool.acquire()
      const second = pool.acquire()
      expect(await first).toBe(LIMIT)
      expect(pool.limit).toBe(1)
      resolveSecond(createFakeClient())
      const c = await second
      expect(c).not.toBeNull()
      expect(c).not.toBe(LIMIT)
    })

    it('421 with nothing open sets limit to 1 and returns null (main client fallback)', async () => {
      manager.createSecondaryClient.mockRejectedValue(
        new FTPError({ code: 421, message: '421 Too many connections' })
      )
      expect(await pool.acquire()).toBeNull()
      expect(pool.limit).toBe(1)
    })

    it('stays in fallback without retrying the server until the pool resets', async () => {
      manager.createSecondaryClient.mockRejectedValue(new FTPError({ code: 421, message: '421 x' }))
      expect(await pool.acquire()).toBeNull()
      expect(await pool.acquire()).toBeNull()
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(1)

      manager.emit('connectionStatus', { status: 'connecting' })
      manager.createSecondaryClient.mockResolvedValue(createFakeClient())
      expect(await pool.acquire()).not.toBeNull()
      expect(pool.limit).toBe(MAX_TRANSFER_CLIENTS)
    })

    it('treats 530 with a connection-limit message the same as 421', async () => {
      await acquireClient()
      await acquireClient()
      manager.createSecondaryClient.mockRejectedValueOnce(
        new FTPError({ code: 530, message: '530 Sorry, the maximum number of clients (2) reached' })
      )
      expect(await pool.acquire()).toBe(LIMIT)
      expect(pool.limit).toBe(2)
    })

    it('530 "Login incorrect" propagates the error and leaves limit unchanged', async () => {
      await acquireClient()
      const err = new FTPError({ code: 530, message: '530 Login incorrect' })
      manager.createSecondaryClient.mockRejectedValueOnce(err)
      await expect(pool.acquire()).rejects.toBe(err)
      expect(pool.limit).toBe(MAX_TRANSFER_CLIENTS)
      expect(pool.connectingCount).toBe(0)
    })

    it('propagates non-FTP errors without changing limit', async () => {
      manager.createSecondaryClient.mockRejectedValueOnce(new Error('Not connected'))
      await expect(pool.acquire()).rejects.toThrow('Not connected')
      expect(pool.limit).toBe(MAX_TRANSFER_CLIENTS)
    })

    it('settles on the logins the server accepted when 421s arrive while others are still logging in', async () => {
      // 서버 한도 3: 10개를 한꺼번에 열면 7개는 421, 3개는 성공한다. 421이 로그인보다 먼저 온다.
      const logins: Array<(c: FakeClient) => void> = []
      const rejects: Array<(err: unknown) => void> = []
      manager.createSecondaryClient.mockImplementation(
        () =>
          new Promise<FakeClient>((resolve, reject) => {
            logins.push(resolve)
            rejects.push(reject)
          })
      )
      const acquires = Array.from({ length: MAX_TRANSFER_CLIENTS }, () => pool.acquire())
      for (const reject of rejects.slice(3)) {
        reject(new FTPError({ code: 421, message: '421 Too many connections' }))
        await Promise.resolve()
      }
      await Promise.all(acquires.slice(3))
      for (const login of logins.slice(0, 3)) login(createFakeClient())
      await Promise.all(acquires.slice(0, 3))

      expect(pool.limit).toBe(3)
      expect(pool.inUseCount).toBe(3)
    })

    it('never regrows the limit within a run', async () => {
      const a = await acquireClient()
      await acquireClient()
      manager.createSecondaryClient.mockRejectedValueOnce(new FTPError({ code: 421, message: 'x' }))
      expect(await pool.acquire()).toBe(LIMIT)
      expect(pool.limit).toBe(2)
      pool.discard(asClient(a))
      expect(pool.limit).toBe(2)
    })
  })

  describe('421 right after closing clients', () => {
    const tooMany = (): FTPError => new FTPError({ code: 421, message: '421 Too many connections' })

    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('waits and logs in again instead of falling back to the main client', async () => {
      // 방금 버린 연결의 슬롯을 서버가 아직 반납하지 않아 다음 로그인이 421을 받는다
      pool.discard(asClient(await acquireClient()))
      manager.createSecondaryClient.mockRejectedValueOnce(tooMany())

      let result: unknown = 'pending'
      void pool.acquire().then((r) => (result = r))
      await vi.advanceTimersByTimeAsync(LOGIN_RETRY_DELAY_MS - 1)
      expect(result).toBe('pending')
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(2)
      expect(pool.connectingCount).toBe(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(result).not.toBeNull()
      expect(result).not.toBe(LIMIT)
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(3)
      expect(pool.limit).toBe(1)
      expect(pool.inUseCount).toBe(1)
    })

    it('falls back to the main client once no close is recent any more', async () => {
      pool.discard(asClient(await acquireClient()))
      manager.createSecondaryClient.mockRejectedValue(tooMany())

      let result: unknown = 'pending'
      void pool.acquire().then((r) => (result = r))
      await vi.advanceTimersByTimeAsync(RECENT_CLOSE_MS + LOGIN_RETRY_DELAY_MS)

      expect(result).toBeNull()
      expect(pool.connectingCount).toBe(0)
      // 창 안에서만 간격을 두고 다시 시도한다
      const logins = manager.createSecondaryClient.mock.calls.length - 1
      expect(logins).toBeGreaterThan(1)
      expect(logins).toBeLessThanOrEqual(RECENT_CLOSE_MS / LOGIN_RETRY_DELAY_MS + 1)
    })

    it('falls back right away when nothing was closed recently', async () => {
      pool.discard(asClient(await acquireClient()))
      await vi.advanceTimersByTimeAsync(RECENT_CLOSE_MS + 1)
      manager.createSecondaryClient.mockRejectedValueOnce(tooMany())

      expect(await pool.acquire()).toBeNull()
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(2)
    })

    it('gives up the wait when the connection is re-established meanwhile', async () => {
      pool.discard(asClient(await acquireClient()))
      manager.createSecondaryClient.mockRejectedValueOnce(tooMany())

      const acquired = pool.acquire()
      acquired.catch(() => {})
      await vi.advanceTimersByTimeAsync(0)
      manager.emit('connectionStatus', { status: 'connecting' })
      await vi.advanceTimersByTimeAsync(LOGIN_RETRY_DELAY_MS)

      await expect(acquired).rejects.toThrow('Not connected')
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(2)
      expect(pool.connectingCount).toBe(0)
    })
  })

  describe('runOnMainClient', () => {
    it('runs the task on the main client through the manager', async () => {
      const main = createFakeClient()
      manager.runOnMainClient.mockImplementation((task: (c: FakeClient) => unknown) => task(main))

      const result = await pool.runOnMainClient(async (c) => (c as unknown as FakeClient) === main)

      expect(result).toBe(true)
      expect(manager.createSecondaryClient).not.toHaveBeenCalled()
    })
  })

  describe('reconnect and lifecycle', () => {
    it.each(['connecting', 'disconnected'])(
      'connectionStatus(%s) closes every client and resets state',
      async (status) => {
        const a = await acquireClient()
        const b = await acquireClient()
        pool.release(asClient(b))
        manager.createSecondaryClient.mockRejectedValueOnce(
          new FTPError({ code: 421, message: 'x' })
        )
        await pool.acquire() // limit -> 2
        pool.segmentedBroken = true
        pool.fastBroken = true

        manager.emit('connectionStatus', { status })

        expect(a.close).toHaveBeenCalled()
        expect(b.close).toHaveBeenCalled()
        expect(pool.idleCount).toBe(0)
        expect(pool.inUseCount).toBe(0)
        expect(pool.limit).toBe(MAX_TRANSFER_CLIENTS)
        expect(pool.segmentedBroken).toBe(false)
        expect(pool.fastBroken).toBe(false)
      }
    )

    it('ignores other connection statuses', async () => {
      const a = await acquireClient()
      manager.emit('connectionStatus', { status: 'connected' })
      expect(a.close).not.toHaveBeenCalled()
      expect(pool.inUseCount).toBe(1)
    })

    it('closes a client that finishes connecting under an old generation', async () => {
      let resolveClient: (c: FakeClient) => void = () => {}
      manager.createSecondaryClient.mockImplementationOnce(
        () => new Promise<FakeClient>((resolve) => (resolveClient = resolve))
      )
      const pending = pool.acquire()
      manager.emit('connectionStatus', { status: 'disconnected' })

      const late = createFakeClient()
      resolveClient(late)

      await expect(pending).rejects.toThrow(/not connected/i)
      expect(late.close).toHaveBeenCalled()
      expect(pool.inUseCount).toBe(0)
      expect(pool.connectingCount).toBe(0)
    })

    it('does not shrink the limit for a 421 that arrives under an old generation', async () => {
      let reject: (e: Error) => void = () => {}
      manager.createSecondaryClient.mockImplementationOnce(
        () => new Promise<FakeClient>((_, rej) => (reject = rej))
      )
      const pending = pool.acquire()
      manager.emit('connectionStatus', { status: 'connecting' })
      reject(new FTPError({ code: 421, message: 'x' }))

      await expect(pending).rejects.toBeInstanceOf(FTPError)
      expect(pool.limit).toBe(MAX_TRANSFER_CLIENTS)
    })

    it('a client released after a reconnect is closed, not pooled', async () => {
      const a = await acquireClient()
      manager.emit('connectionStatus', { status: 'disconnected' })
      pool.release(asClient(a))
      expect(pool.idleCount).toBe(0)
    })

    it('dispose unsubscribes from connectionStatus and closes clients', async () => {
      const a = await acquireClient()
      pool.dispose()
      expect(a.close).toHaveBeenCalled()
      expect(manager.listenerCount('connectionStatus')).toBe(0)
    })
  })

  describe('idle close', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('closes idle clients after POOL_IDLE_CLOSE_MS and resets the limit', async () => {
      const a = await acquireClient()
      const b = await acquireClient()
      manager.createSecondaryClient.mockRejectedValueOnce(new FTPError({ code: 421, message: 'x' }))
      await pool.acquire() // limit -> 2
      pool.release(asClient(a))
      pool.release(asClient(b))

      pool.armIdleClose()
      vi.advanceTimersByTime(POOL_IDLE_CLOSE_MS - 1)
      expect(a.close).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)

      expect(a.close).toHaveBeenCalled()
      expect(pool.idleCount).toBe(0)
      expect(pool.limit).toBe(MAX_TRANSFER_CLIENTS)
    })

    it('keeps fastBroken across an idle close: only a reconnect resets it', async () => {
      const a = await acquireClient()
      pool.release(asClient(a))
      pool.fastBroken = true

      pool.armIdleClose()
      vi.advanceTimersByTime(POOL_IDLE_CLOSE_MS)

      expect(a.close).toHaveBeenCalled()
      expect(pool.fastBroken).toBe(true)
    })

    it('cancelIdleClose prevents the close', async () => {
      const a = await acquireClient()
      pool.release(asClient(a))
      pool.armIdleClose()
      pool.cancelIdleClose()
      vi.advanceTimersByTime(POOL_IDLE_CLOSE_MS * 2)
      expect(a.close).not.toHaveBeenCalled()
      expect(pool.idleCount).toBe(1)
    })

    it('acquire cancels a pending idle close', async () => {
      const a = await acquireClient()
      pool.release(asClient(a))
      pool.armIdleClose()
      await acquireClient()
      vi.advanceTimersByTime(POOL_IDLE_CLOSE_MS * 2)
      expect(a.close).not.toHaveBeenCalled()
    })

    it('re-arming restarts the timer', async () => {
      const a = await acquireClient()
      pool.release(asClient(a))
      pool.armIdleClose()
      vi.advanceTimersByTime(POOL_IDLE_CLOSE_MS - 1)
      pool.armIdleClose()
      vi.advanceTimersByTime(POOL_IDLE_CLOSE_MS - 1)
      expect(a.close).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(a.close).toHaveBeenCalled()
    })

    it('keeps clients that are still in use when the idle timer fires', async () => {
      const busy = await acquireClient()
      const idle = await acquireClient()
      pool.release(asClient(idle))
      pool.armIdleClose()
      vi.advanceTimersByTime(POOL_IDLE_CLOSE_MS)
      expect(idle.close).toHaveBeenCalled()
      expect(busy.close).not.toHaveBeenCalled()
      expect(pool.inUseCount).toBe(1)
    })
  })
})
