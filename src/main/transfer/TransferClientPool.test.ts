import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { FTPError, type Client } from 'basic-ftp'
import {
  TransferClientPool,
  LIMIT,
  MAX_TRANSFER_CLIENTS,
  POOL_IDLE_CLOSE_MS,
  RECENT_CLOSE_MS,
  LOGIN_RETRY_DELAY_MS,
  REFUSED_LOGIN_BACKOFF_MS,
  PROBE_COOLDOWN_MS,
  MAX_PROBE_COOLDOWN_MS
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

    it('reports a fresh login once per client, and not for a reused idle client', async () => {
      const a = await acquireClient()
      expect(pool.takeFreshLogin(asClient(a))).toBe(true)
      expect(pool.takeFreshLogin(asClient(a))).toBe(false)
      pool.release(asClient(a))
      const again = await acquireClient()
      expect(again).toBe(a)
      expect(pool.takeFreshLogin(asClient(again))).toBe(false)
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

    it('530 "Login incorrect" with nothing open propagates the error and leaves limit unchanged', async () => {
      const err = new FTPError({ code: 530, message: '530 Login incorrect' })
      manager.createSecondaryClient.mockRejectedValueOnce(err)
      await expect(pool.acquire()).rejects.toBe(err)
      expect(pool.limit).toBe(MAX_TRANSFER_CLIENTS)
      expect(pool.connectingCount).toBe(0)
    })

    it('caps the limit to the logins still in flight when a login fails with nothing open', async () => {
      // 함께 연결 중인 로그인이 되더라도, 실패할 로그인을 큐가 다시 limit만큼 몰지 않게 한다
      const err = new FTPError({ code: 530, message: '530 Login incorrect' })
      const logins: Array<(c: FakeClient) => void> = []
      manager.createSecondaryClient
        .mockRejectedValueOnce(err)
        .mockImplementation(() => new Promise<FakeClient>((resolve) => logins.push(resolve)))
      const failed = pool.acquire()
      const pending = [pool.acquire(), pool.acquire()]

      await expect(failed).rejects.toBe(err)
      expect(pool.limit).toBe(2)
      for (const login of logins) login(createFakeClient())
      const [first] = (await Promise.all(pending)) as unknown as FakeClient[]
      expect(pool.limit).toBe(2)
      expect(await pool.acquire()).toBe(LIMIT)
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(3)

      // 버려진 클라이언트를 대신하는 로그인은 limit 안의 로그인이라 limit를 늘리지 않는다
      pool.discard(asClient(first))
      manager.createSecondaryClient.mockResolvedValueOnce(createFakeClient())
      await acquireClient()
      expect(pool.limit).toBe(2)
      expect(await pool.acquire()).toBe(LIMIT)
    })

    it('grows back one probe login at a time after a whole failed burst', async () => {
      // 한꺼번에 시작한 로그인이 모두 실패하면 limit가 1까지 줄어든다. 쉬었다가 limit 위로 하나씩 시험해 늘린다.
      vi.useFakeTimers()
      const err = new FTPError({ code: 530, message: '530 Login incorrect' })
      manager.createSecondaryClient.mockRejectedValue(err)
      const burst = Array.from({ length: MAX_TRANSFER_CLIENTS }, () => pool.acquire())
      for (const acquire of burst) await expect(acquire).rejects.toBe(err)
      expect(pool.limit).toBe(1)

      manager.createSecondaryClient.mockImplementation(async () => createFakeClient())
      await acquireClient()
      expect(pool.limit).toBe(1)
      expect(await pool.acquire()).toBe(LIMIT)

      await vi.advanceTimersByTimeAsync(PROBE_COOLDOWN_MS)
      for (let limit = 2; limit <= MAX_TRANSFER_CLIENTS; limit++) {
        await acquireClient()
        expect(pool.limit).toBe(limit)
      }
      expect(pool.slots).toBe(MAX_TRANSFER_CLIENTS)
      expect(await pool.acquire()).toBe(LIMIT)
    })

    it('raises the limit to the logins the server holds at once when logins in flight beside a failed one succeed', async () => {
      // 하나가 열린 채 로그인 하나가 실패하고, 함께 연결 중이던 로그인은 늦게 된다: 서버가 3개를 함께 받는다
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await acquireClient()
      const logins: Array<(c: FakeClient) => void> = []
      manager.createSecondaryClient
        .mockRejectedValueOnce(new FTPError({ code: 530, message: '530 Login incorrect' }))
        .mockImplementation(() => new Promise<FakeClient>((resolve) => logins.push(resolve)))
      const failed = pool.acquire()
      const pending = [pool.acquire(), pool.acquire()]

      expect(await failed).toBe(LIMIT)
      expect(pool.limit).toBe(1)
      for (const login of logins) login(createFakeClient())
      await Promise.all(pending)
      expect(pool.limit).toBe(3)
      warn.mockRestore()
    })

    it('never probes above a later connection-limit shrink', async () => {
      // 530으로 줄인 뒤 421이 오면 서버의 연결 수 제한이 상한이 된다
      vi.useFakeTimers()
      const logins: Array<(c: FakeClient) => void> = []
      manager.createSecondaryClient
        .mockRejectedValueOnce(new FTPError({ code: 530, message: '530 Login incorrect' }))
        .mockImplementationOnce(() => new Promise<FakeClient>((resolve) => logins.push(resolve)))
        .mockRejectedValueOnce(new FTPError({ code: 421, message: '421 Too many connections' }))
      const failed = pool.acquire()
      const opened = pool.acquire()
      const refused = pool.acquire()

      await expect(failed).rejects.toThrow('Login incorrect')
      expect(await refused).toBe(LIMIT)
      logins[0](createFakeClient())
      pool.discard(asClient((await opened) as unknown as FakeClient))
      manager.createSecondaryClient.mockResolvedValueOnce(createFakeClient())
      await acquireClient()
      expect(pool.limit).toBe(1)

      await vi.advanceTimersByTimeAsync(MAX_PROBE_COOLDOWN_MS)
      expect(pool.probeDelay()).toBe(Infinity)
      expect(await pool.acquire()).toBe(LIMIT)
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(4)
    })

    it('does not raise the limit when a later login only replaces a client lost since the failure', async () => {
      // 2개가 열린 채 로그인이 실패했다. 버려진 하나를 대신한 로그인은 서버가 그 2개까지 받는다는 것만
      // 보여 준다. 늘리면 클라이언트를 잃을 때마다 실패할 로그인이 다시 몰린다.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const first = await acquireClient()
      await acquireClient()
      manager.createSecondaryClient.mockRejectedValueOnce(
        new FTPError({ code: 530, message: '530 Login incorrect' })
      )
      expect(await pool.acquire()).toBe(LIMIT)
      expect(pool.limit).toBe(2)

      pool.discard(asClient(first))
      await acquireClient()
      expect(pool.limit).toBe(2)
      expect(await pool.acquire()).toBe(LIMIT)
      warn.mockRestore()
    })

    it('grows back only up to an earlier connection-limit shrink', async () => {
      // 421로 4까지 줄인 뒤 530으로 더 줄였다. 시험 로그인으로 다시 늘려도 서버가 알린 4는 넘지 않는다.
      vi.useFakeTimers()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const open = [await acquireClient(), await acquireClient()]
      await acquireClient()
      await acquireClient()
      manager.createSecondaryClient.mockRejectedValueOnce(
        new FTPError({ code: 421, message: '421 Too many connections' })
      )
      expect(await pool.acquire()).toBe(LIMIT)
      expect(pool.limit).toBe(4)

      for (const client of open) pool.discard(asClient(client))
      const logins: Array<(c: FakeClient) => void> = []
      manager.createSecondaryClient
        .mockRejectedValueOnce(new FTPError({ code: 530, message: '530 Login incorrect' }))
        .mockImplementationOnce(() => new Promise<FakeClient>((resolve) => logins.push(resolve)))
      const failed = pool.acquire()
      const pending = pool.acquire()

      expect(await failed).toBe(LIMIT)
      expect(pool.limit).toBe(2)
      logins[0](createFakeClient())
      await pending
      expect(pool.limit).toBe(3)

      await vi.advanceTimersByTimeAsync(PROBE_COOLDOWN_MS)
      await acquireClient()
      expect(pool.limit).toBe(4)
      const calls = manager.createSecondaryClient.mock.calls.length
      await vi.advanceTimersByTimeAsync(MAX_PROBE_COOLDOWN_MS)
      expect(pool.probeDelay()).toBe(Infinity)
      expect(await pool.acquire()).toBe(LIMIT)
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(calls)
      warn.mockRestore()
    })

    it.each([
      ['530 "Login incorrect"', new FTPError({ code: 530, message: '530 Login incorrect' })],
      ['a non-FTP error', new Error('Unexpected')]
    ])('treats %s while others are open as a limit: the open clients carry on', async (_, err) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await acquireClient()
      await acquireClient()
      manager.createSecondaryClient.mockRejectedValueOnce(err)

      expect(await pool.acquire()).toBe(LIMIT)
      expect(pool.limit).toBe(2)
      expect(pool.connectingCount).toBe(0)
      // 줄인 limit 안에서는 같은 실패를 되풀이하러 서버를 다시 두드리지 않는다
      expect(await pool.acquire()).toBe(LIMIT)
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(3)
      warn.mockRestore()
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

  describe('refused secondary login', () => {
    /** 메인 세션은 로그인해 있는데 보조 연결의 connect가 거부된 형태 */
    const refused = (): Error =>
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:2121 (control socket)'), {
        code: 'ECONNREFUSED',
        syscall: 'connect',
        address: '127.0.0.1',
        port: 2121
      })
    const backoffTotal = REFUSED_LOGIN_BACKOFF_MS.reduce((a, b) => a + b, 0)

    beforeEach(() => {
      vi.useFakeTimers()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.mocked(console.warn).mockRestore()
    })

    it.each([
      ['ECONNREFUSED', refused()],
      ['ECONNRESET', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
      ['ETIMEDOUT', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })],
      ['an unexpected FIN', new Error('Server sent FIN packet unexpectedly, closing connection.')],
      ['an unexpected close', new Error('Server closed connection unexpectedly.')]
    ])('treats %s while others are open as a limit: LIMIT and a smaller limit', async (_, err) => {
      for (let i = 0; i < 4; i++) await acquireClient()
      manager.createSecondaryClient.mockRejectedValueOnce(err)

      expect(await pool.acquire()).toBe(LIMIT)
      expect(pool.limit).toBe(4)
      expect(pool.connectingCount).toBe(0)
      // 줄인 limit 안에서는 서버를 다시 두드리지 않는다
      expect(await pool.acquire()).toBe(LIMIT)
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(5)
    })

    it('returns LIMIT without shrinking while only other logins are in flight', async () => {
      // 함께 몰린 로그인은 함께 거부될 수 있어, 연결 중인 수로 줄이면 limit가 1까지 무너진다
      let resolveSecond: (c: FakeClient) => void = () => {}
      manager.createSecondaryClient
        .mockRejectedValueOnce(refused())
        .mockImplementationOnce(
          () => new Promise<FakeClient>((resolve) => (resolveSecond = resolve))
        )
      const first = pool.acquire()
      const second = pool.acquire()
      expect(await first).toBe(LIMIT)
      expect(pool.limit).toBe(MAX_TRANSFER_CLIENTS)
      expect(pool.connectingCount).toBe(1)
      resolveSecond(createFakeClient())
      expect(await second).not.toBe(LIMIT)
    })

    it('shrinks only to the open connections, not to the logins still in flight', async () => {
      for (let i = 0; i < 2; i++) await acquireClient()
      manager.createSecondaryClient
        .mockRejectedValueOnce(refused())
        .mockImplementationOnce(() => new Promise<FakeClient>(() => {}))
      const refusedAcquire = pool.acquire()
      void pool.acquire()

      expect(await refusedAcquire).toBe(LIMIT)
      expect(pool.limit).toBe(2)
    })

    it('raises the limit back to the logins the server accepted after a late refusal', async () => {
      // 3개는 10ms에 되고, 1개는 20ms에 거부되고(그때 열린 3개로 줄어든다), 나머지 12개는 30ms에 된다.
      // 서버가 15개를 받았으니 limit도 15여야 한다. 3에 묶이면 나머지 12개는 idle close까지 놀고 있다.
      let logins = 0
      manager.createSecondaryClient.mockImplementation(() => {
        const n = ++logins
        if (n <= 3) {
          return new Promise((resolve) => setTimeout(() => resolve(createFakeClient()), 10))
        }
        if (n === 4) return new Promise((_, reject) => setTimeout(() => reject(refused()), 20))
        return new Promise((resolve) => setTimeout(() => resolve(createFakeClient()), 30))
      })
      const results = Array.from({ length: MAX_TRANSFER_CLIENTS }, () => pool.acquire())

      await vi.advanceTimersByTimeAsync(20)
      expect(pool.limit).toBe(3)
      await vi.advanceTimersByTimeAsync(10)
      await Promise.all(results)

      expect(pool.inUseCount).toBe(MAX_TRANSFER_CLIENTS - 1)
      expect(pool.limit).toBe(MAX_TRANSFER_CLIENTS - 1)
    })

    it('never raises the limit above the configured number of transfers', async () => {
      for (let i = 0; i < 2; i++) await acquireClient()
      let resolveLate: (c: FakeClient) => void = () => {}
      manager.createSecondaryClient
        .mockImplementationOnce(() => new Promise<FakeClient>((resolve) => (resolveLate = resolve)))
        .mockRejectedValueOnce(refused())
      const late = pool.acquire()
      expect(await pool.acquire()).toBe(LIMIT)
      expect(pool.limit).toBe(2)

      manager.getMaxTransfers.mockReturnValue(2)
      resolveLate(createFakeClient())
      await late

      expect(pool.inUseCount).toBe(3)
      expect(pool.limit).toBe(2)
    })

    it('keeps the limit when a whole burst of logins is refused and recovers once they succeed', async () => {
      for (let i = 0; i < MAX_TRANSFER_CLIENTS; i++) {
        manager.createSecondaryClient.mockRejectedValueOnce(refused())
      }
      const results: unknown[] = []
      for (let i = 0; i < MAX_TRANSFER_CLIENTS; i++)
        void pool.acquire().then((r) => results.push(r))
      await vi.advanceTimersByTimeAsync(0)

      // 마지막으로 거부된 하나만 남은 슬롯을 잡고 쉬었다 다시 로그인하고, 나머지는 LIMIT로 큐에 돌아간다
      expect(results).toEqual(Array(MAX_TRANSFER_CLIENTS - 1).fill(LIMIT))
      expect(pool.limit).toBe(MAX_TRANSFER_CLIENTS)
      expect(pool.connectingCount).toBe(1)

      await vi.advanceTimersByTimeAsync(REFUSED_LOGIN_BACKOFF_MS[0])
      expect(results).toHaveLength(MAX_TRANSFER_CLIENTS)
      expect(results.at(-1)).not.toBe(LIMIT)
      expect(results.at(-1)).not.toBeNull()
      expect(pool.limit).toBe(MAX_TRANSFER_CLIENTS)
      // 이후 로그인이 되면 limit만큼 다시 연다
      const more = await Promise.all(
        Array.from({ length: MAX_TRANSFER_CLIENTS - 1 }, () => pool.acquire())
      )
      expect(more.every((c) => c !== LIMIT && c !== null)).toBe(true)
      expect(pool.inUseCount).toBe(MAX_TRANSFER_CLIENTS)
    })

    it('backs off and logs in again when nothing else is open', async () => {
      manager.createSecondaryClient.mockRejectedValueOnce(refused())

      let result: unknown = 'pending'
      void pool.acquire().then((r) => (result = r))
      await vi.advanceTimersByTimeAsync(REFUSED_LOGIN_BACKOFF_MS[0] - 1)
      expect(result).toBe('pending')
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(1)
      // 기다리는 동안 슬롯을 잡아 둬 다른 acquire가 로그인을 몰아 시도하지 않는다
      expect(pool.connectingCount).toBe(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(result).not.toBeNull()
      expect(result).not.toBe(LIMIT)
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(2)
      expect(pool.inUseCount).toBe(1)
      expect(pool.limit).toBe(MAX_TRANSFER_CLIENTS)
    })

    it('waits longer after each refusal before trying again', async () => {
      manager.createSecondaryClient.mockRejectedValue(refused())

      void pool.acquire()
      const callsAt: number[] = []
      for (const delay of REFUSED_LOGIN_BACKOFF_MS) {
        await vi.advanceTimersByTimeAsync(delay - 1)
        callsAt.push(manager.createSecondaryClient.mock.calls.length)
        await vi.advanceTimersByTimeAsync(1)
      }
      // 각 대기의 끝 직전까지는 다시 로그인하지 않는다
      expect(callsAt).toEqual(REFUSED_LOGIN_BACKOFF_MS.map((_, i) => i + 1))
    })

    it('gives up after a bounded number of tries and falls back to the main client', async () => {
      manager.createSecondaryClient.mockRejectedValue(refused())

      let result: unknown = 'pending'
      void pool.acquire().then((r) => (result = r))
      await vi.advanceTimersByTimeAsync(backoffTotal)

      expect(result).toBeNull()
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(
        REFUSED_LOGIN_BACKOFF_MS.length + 1
      )
      expect(pool.connectingCount).toBe(0)
      expect(pool.limit).toBe(1)
      // 이후 acquire는 로그인을 다시 시도하지 않는다
      expect(await pool.acquire()).toBeNull()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(
        REFUSED_LOGIN_BACKOFF_MS.length + 1
      )
    })

    it('gives up the backoff when the connection is re-established meanwhile', async () => {
      manager.createSecondaryClient.mockRejectedValueOnce(refused())

      const acquired = pool.acquire()
      acquired.catch(() => {})
      await vi.advanceTimersByTimeAsync(0)
      manager.emit('connectionStatus', { status: 'connecting' })
      await vi.advanceTimersByTimeAsync(REFUSED_LOGIN_BACKOFF_MS[0])

      await expect(acquired).rejects.toThrow('Not connected')
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(1)
      expect(pool.connectingCount).toBe(0)
    })

    it('propagates a refusal that arrives under an old generation', async () => {
      let rejectLogin: (err: unknown) => void = () => {}
      manager.createSecondaryClient.mockImplementationOnce(
        () => new Promise<FakeClient>((_, reject) => (rejectLogin = reject))
      )
      const acquired = pool.acquire()
      manager.emit('connectionStatus', { status: 'connecting' })
      const err = refused()
      rejectLogin(err)

      await expect(acquired).rejects.toBe(err)
      expect(pool.limit).toBe(MAX_TRANSFER_CLIENTS)
    })
  })

  describe('probe logins above a lowered limit', () => {
    const loginIncorrect = (): FTPError =>
      new FTPError({ code: 530, message: '530 Login incorrect' })
    const refused = (): Error =>
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:2121'), { code: 'ECONNREFUSED' })

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.mocked(console.warn).mockRestore()
    })

    /** 2개가 열린 채 로그인이 실패해 limit가 2로 줄어든 풀. 열린 2개를 돌려준다. */
    async function lowerToTwo(): Promise<FakeClient[]> {
      const open = [await acquireClient(), await acquireClient()]
      manager.createSecondaryClient.mockRejectedValueOnce(loginIncorrect())
      expect(await pool.acquire()).toBe(LIMIT)
      expect(pool.limit).toBe(2)
      return open
    }

    /** 다음 acquire의 로그인을 붙잡아 둔다. 돌려준 함수로 끝낸다. */
    function holdNextLogin(): (c: FakeClient) => void {
      let finish: (c: FakeClient) => void = () => {}
      manager.createSecondaryClient.mockImplementationOnce(
        () => new Promise<FakeClient>((resolve) => (finish = resolve))
      )
      return (c) => finish(c)
    }

    it('starts no probe until PROBE_COOLDOWN_MS after a failed login', async () => {
      await lowerToTwo()
      expect(pool.slots).toBe(2)
      expect(pool.probeDelay()).toBe(PROBE_COOLDOWN_MS)

      await vi.advanceTimersByTimeAsync(PROBE_COOLDOWN_MS - 1)
      expect(await pool.acquire()).toBe(LIMIT)
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(1)
      expect(pool.probeDelay()).toBe(0)
      expect(pool.slots).toBe(3)
      await acquireClient()
      expect(pool.limit).toBe(3)
      // 시험 로그인이 되면 다음 시험 로그인은 바로 할 수 있다
      expect(pool.probeDelay()).toBe(0)
      expect(pool.slots).toBe(4)
    })

    it('runs one probe at a time and counts it as a slot while it logs in', async () => {
      await lowerToTwo()
      await vi.advanceTimersByTimeAsync(PROBE_COOLDOWN_MS)
      const finishProbe = holdNextLogin()
      const probe = pool.acquire()

      expect(pool.connectingCount).toBe(1)
      expect(pool.slots).toBe(3)
      expect(pool.probeDelay()).toBe(Infinity)
      expect(await pool.acquire()).toBe(LIMIT)
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(4)

      finishProbe(createFakeClient())
      await probe
      expect(pool.limit).toBe(3)
    })

    it('doubles the wait after each failed probe up to MAX_PROBE_COOLDOWN_MS without lowering the limit', async () => {
      await lowerToTwo()
      manager.createSecondaryClient.mockRejectedValue(loginIncorrect())
      const waits: number[] = []
      for (let i = 0; i < 7; i++) {
        const wait = pool.probeDelay()
        waits.push(wait)
        await vi.advanceTimersByTimeAsync(wait)
        expect(await pool.acquire()).toBe(LIMIT)
        // 시험 로그인은 limit 위의 로그인이었다: 실패해도 열린 연결로 계속한다
        expect(pool.limit).toBe(2)
      }
      expect(waits).toEqual([
        PROBE_COOLDOWN_MS,
        2 * PROBE_COOLDOWN_MS,
        4 * PROBE_COOLDOWN_MS,
        8 * PROBE_COOLDOWN_MS,
        16 * PROBE_COOLDOWN_MS,
        MAX_PROBE_COOLDOWN_MS,
        MAX_PROBE_COOLDOWN_MS
      ])
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(3 + 7)
    })

    it('treats a refused probe like a failed one', async () => {
      await lowerToTwo()
      await vi.advanceTimersByTimeAsync(PROBE_COOLDOWN_MS)
      manager.createSecondaryClient.mockRejectedValueOnce(refused())

      expect(await pool.acquire()).toBe(LIMIT)
      expect(pool.limit).toBe(2)
      expect(pool.connectingCount).toBe(0)
      expect(pool.probeDelay()).toBe(2 * PROBE_COOLDOWN_MS)
    })

    it('goes back to the first wait once a probe succeeds', async () => {
      await lowerToTwo()
      manager.createSecondaryClient.mockRejectedValueOnce(loginIncorrect())
      await vi.advanceTimersByTimeAsync(PROBE_COOLDOWN_MS)
      expect(await pool.acquire()).toBe(LIMIT)
      expect(pool.probeDelay()).toBe(2 * PROBE_COOLDOWN_MS)

      await vi.advanceTimersByTimeAsync(2 * PROBE_COOLDOWN_MS)
      await acquireClient()
      expect(pool.limit).toBe(3)
      manager.createSecondaryClient.mockRejectedValueOnce(loginIncorrect())
      expect(await pool.acquire()).toBe(LIMIT)
      expect(pool.probeDelay()).toBe(PROBE_COOLDOWN_MS)
    })

    it('starts one wait for a burst of failed logins, and failures during it do not extend it', async () => {
      manager.createSecondaryClient.mockRejectedValue(loginIncorrect())
      const burst = Array.from({ length: MAX_TRANSFER_CLIENTS }, () => pool.acquire())
      for (const acquire of burst) await expect(acquire).rejects.toThrow('Login incorrect')
      expect(pool.limit).toBe(1)
      expect(pool.probeDelay()).toBe(PROBE_COOLDOWN_MS)

      await vi.advanceTimersByTimeAsync(PROBE_COOLDOWN_MS / 2)
      await expect(pool.acquire()).rejects.toThrow('Login incorrect')
      expect(pool.probeDelay()).toBe(PROBE_COOLDOWN_MS / 2)
    })

    it('replaces a lost client within the limit without waiting', async () => {
      const [first] = await lowerToTwo()
      pool.discard(asClient(first))

      await acquireClient()
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(4)
      expect(pool.limit).toBe(2)
      expect(pool.probeDelay()).toBe(PROBE_COOLDOWN_MS)
    })

    it('lets a lost client be replaced while a probe logs in, and raises the limit when both are held', async () => {
      const [first] = await lowerToTwo()
      await vi.advanceTimersByTimeAsync(PROBE_COOLDOWN_MS)
      const finishProbe = holdNextLogin()
      const probe = pool.acquire()
      pool.discard(asClient(first))

      // 시험 로그인은 limit 밖의 슬롯이라 잃은 클라이언트는 바로 대신한다
      await acquireClient()
      expect(pool.limit).toBe(2)
      finishProbe(createFakeClient())
      await probe
      expect(pool.limit).toBe(3)
    })

    it('does not count a probe that only fills the slot of a lost client as more room', async () => {
      // 2개가 열린 채 시험 로그인을 시작했는데 그 사이 하나를 잃었다. 시험 로그인이 되어도 열린 수는 2라 서버가
      // 더 받는다는 뜻이 아니다: limit도, 늘어난 대기 시간도 그대로다.
      const [first] = await lowerToTwo()
      manager.createSecondaryClient.mockRejectedValueOnce(loginIncorrect())
      await vi.advanceTimersByTimeAsync(PROBE_COOLDOWN_MS)
      expect(await pool.acquire()).toBe(LIMIT)
      await vi.advanceTimersByTimeAsync(2 * PROBE_COOLDOWN_MS)

      const finishProbe = holdNextLogin()
      const probe = pool.acquire()
      pool.discard(asClient(first))
      finishProbe(createFakeClient())
      await probe
      expect(pool.limit).toBe(2)

      manager.createSecondaryClient.mockRejectedValueOnce(loginIncorrect())
      expect(await pool.acquire()).toBe(LIMIT)
      expect(pool.probeDelay()).toBe(4 * PROBE_COOLDOWN_MS)
    })

    it('stops probing once a probe is told the connection limit', async () => {
      await lowerToTwo()
      await vi.advanceTimersByTimeAsync(PROBE_COOLDOWN_MS)
      manager.createSecondaryClient.mockRejectedValueOnce(
        new FTPError({ code: 421, message: '421 Too many connections' })
      )

      expect(await pool.acquire()).toBe(LIMIT)
      expect(pool.limit).toBe(2)
      await vi.advanceTimersByTimeAsync(MAX_PROBE_COOLDOWN_MS)
      expect(pool.probeDelay()).toBe(Infinity)
      expect(await pool.acquire()).toBe(LIMIT)
      expect(manager.createSecondaryClient).toHaveBeenCalledTimes(4)
    })

    it('never probes above the configured number of transfers', async () => {
      await lowerToTwo()
      manager.getMaxTransfers.mockReturnValue(2)
      await vi.advanceTimersByTimeAsync(PROBE_COOLDOWN_MS)

      expect(pool.probeDelay()).toBe(Infinity)
      expect(pool.slots).toBe(2)
      expect(await pool.acquire()).toBe(LIMIT)
    })

    it.each(['a reconnect', 'an idle close'])(
      'starts over from the first wait after %s',
      async (how) => {
        const open = await lowerToTwo()
        manager.createSecondaryClient.mockRejectedValueOnce(loginIncorrect())
        await vi.advanceTimersByTimeAsync(PROBE_COOLDOWN_MS)
        expect(await pool.acquire()).toBe(LIMIT)
        expect(pool.probeDelay()).toBe(2 * PROBE_COOLDOWN_MS)

        if (how === 'a reconnect') {
          manager.emit('connectionStatus', { status: 'connecting' })
          manager.emit('connectionStatus', { status: 'connected' })
        } else {
          for (const client of open) pool.release(asClient(client))
          pool.armIdleClose()
          await vi.advanceTimersByTimeAsync(POOL_IDLE_CLOSE_MS)
        }
        expect(pool.limit).toBe(MAX_TRANSFER_CLIENTS)
        expect(pool.probeDelay()).toBe(Infinity)

        await lowerToTwo()
        expect(pool.probeDelay()).toBe(PROBE_COOLDOWN_MS)
      }
    )
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
