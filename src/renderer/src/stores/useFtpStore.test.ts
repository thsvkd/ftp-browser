import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useFtpStore } from './useFtpStore'
import { useListingStore } from './useListingStore'
import { useTabsStore } from './useTabsStore'
import type { FtpConnectPayload } from '@shared/types/ftp'

const mockInvoke = vi.fn()

vi.stubGlobal('window', {
  api: {
    invoke: mockInvoke
  }
})

const CONFIG: FtpConnectPayload = {
  host: 'ftp.example.com',
  port: 21,
  user: 'user',
  password: 'pass',
  secure: false
}
const KEY = 'user@ftp.example.com:21'

const B: FtpConnectPayload = { host: 'b.example.com', port: 2121, user: 'bob', secure: false }
const KEY_B = 'bob@b.example.com:2121'

function resetStore(): void {
  useFtpStore.setState({ connections: {} })
  useTabsStore.setState({ tabs: [], activeId: '', recent: [] })
  useListingStore.setState({ byKey: {} })
}

const channels = (): string[] => mockInvoke.mock.calls.map((c) => c[0] as string)

describe('useFtpStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
  })

  it('connects and lists the initial path', async () => {
    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'ftp:connect') return { success: true, data: undefined }
      if (channel === 'ftp:list') {
        return { success: true, data: { path: args[1], entries: [] } }
      }
      return { success: true, data: undefined }
    })

    await expect(useFtpStore.getState().connect(CONFIG, '/photos')).resolves.toBe(true)
    expect(useFtpStore.getState().connections[KEY]).toMatchObject({
      status: 'connected',
      host: 'ftp.example.com'
    })
    expect(useTabsStore.getState().tabs.map((t) => t.loc.path)).toEqual(['/photos'])
    expect(channels()).toEqual(['ftp:connect', 'ftp:list'])
  })

  it('falls back to the root when the start folder cannot be read, and fails when neither can', async () => {
    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'ftp:list' && args[1] === '/gone') return { success: false, error: 'gone' }
      if (channel === 'ftp:list') return { success: true, data: { path: args[1], entries: [] } }
      return { success: true, data: undefined }
    })
    await expect(useFtpStore.getState().connect(CONFIG, '/gone')).resolves.toBe(true)
    expect(useTabsStore.getState().tabs.map((t) => t.loc.path)).toEqual(['/'])

    resetStore()
    mockInvoke.mockImplementation((channel: string) =>
      channel === 'ftp:list' ? { success: false, error: 'denied' } : { success: true }
    )
    await expect(useFtpStore.getState().connect(CONFIG, '/x')).resolves.toBe(false)
    expect(useFtpStore.getState().connections[KEY].error).toBe('denied')
  })

  it('keeps every connection: a second connect adds one, and a failure marks only its key', async () => {
    // covers: Test-1011
    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'ftp:connect') {
        const payload = args[0] as FtpConnectPayload
        return payload.host === 'c.example.com'
          ? { success: false, error: '530 Login incorrect' }
          : { success: true, data: undefined }
      }
      if (channel === 'ftp:list') return { success: true, data: { path: args[1], entries: [] } }
      return { success: true, data: undefined }
    })
    const ftp = useFtpStore.getState()
    await expect(ftp.connect(CONFIG)).resolves.toBe(true)
    await expect(ftp.connect(B)).resolves.toBe(true)
    expect(useFtpStore.getState().connections[KEY].status).toBe('connected')
    expect(useFtpStore.getState().connections[KEY_B].status).toBe('connected')
    expect(channels()).not.toContain('ftp:disconnect')

    const C: FtpConnectPayload = { host: 'c.example.com', port: 21, user: 'c', secure: false }
    await expect(ftp.connect(C)).resolves.toBe(false)
    expect(useFtpStore.getState().connections['c@c.example.com:21'].error).toBe(
      '530 Login incorrect'
    )
    expect(useFtpStore.getState().connections[KEY]).toMatchObject({
      status: 'connected',
      error: null
    })
    expect(useFtpStore.getState().connections[KEY_B].status).toBe('connected')

    // adopt: false (auto connect) neither lists nor moves a tab
    resetStore()
    mockInvoke.mockClear()
    await expect(ftp.connect(B, '/photos', { adopt: false })).resolves.toBe(true)
    expect(useFtpStore.getState().connections[KEY_B].status).toBe('connected')
    expect(channels()).toEqual(['ftp:connect'])
    expect(useTabsStore.getState().tabs).toEqual([])
  })

  it('changes only the key an event or a disconnect names', async () => {
    // covers: Test-1012
    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'ftp:list') return { success: true, data: { path: args[1], entries: [] } }
      return { success: true, data: undefined }
    })
    const ftp = useFtpStore.getState()
    await ftp.connect(CONFIG)
    await ftp.connect(B)

    ftp.setConnectionState({
      server: KEY_B,
      status: 'error',
      host: 'b.example.com',
      port: 2121,
      user: 'bob',
      error: 'Connection lost'
    })
    expect(useFtpStore.getState().connections[KEY_B]).toMatchObject({
      status: 'error',
      error: 'Connection lost'
    })
    expect(useFtpStore.getState().connections[KEY]).toMatchObject({
      status: 'connected',
      error: null
    })

    await ftp.disconnect(KEY_B)
    expect(mockInvoke).toHaveBeenLastCalledWith('ftp:disconnect', KEY_B)
    expect(useFtpStore.getState().connections[KEY_B]).toMatchObject({
      status: 'disconnected',
      host: 'b.example.com',
      port: 2121,
      user: 'bob'
    })
    expect(useFtpStore.getState().connections[KEY].status).toBe('connected')

    ftp.adoptSession({ server: KEY_B, status: 'connected', host: 'b.example.com', port: 2121 })
    expect(useFtpStore.getState().connections[KEY_B].status).toBe('connected')
    ftp.adoptSession({ server: KEY_B, status: 'disconnected' })
    expect(useFtpStore.getState().connections[KEY_B].status).toBe('disconnected')
    expect(useFtpStore.getState().connections[KEY].status).toBe('connected')

    // B의 늦게 온 연결 결과는 B에 대한 disconnect 뒤 버려진다. A는 그대로다
    let resolveB: ((value: { success: true }) => void) | undefined
    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'ftp:connect' && (args[0] as FtpConnectPayload).host === 'b.example.com')
        return new Promise((resolve) => (resolveB = resolve))
      if (channel === 'ftp:list') return { success: true, data: { path: args[1], entries: [] } }
      return { success: true, data: undefined }
    })
    const late = ftp.connect(B)
    await ftp.disconnect(KEY_B)
    resolveB!({ success: true })
    await expect(late).resolves.toBe(false)
    expect(useFtpStore.getState().connections[KEY_B].status).toBe('disconnected')
    expect(useFtpStore.getState().connections[KEY].status).toBe('connected')
  })

  describe('connect cancelled by disconnect', () => {
    it('does not apply a successful connect that finishes after disconnect', async () => {
      let resolveConnect: ((value: { success: true; data: undefined }) => void) | undefined
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ftp:connect') {
          return new Promise((resolve) => {
            resolveConnect = resolve
          })
        }
        if (channel === 'ftp:disconnect') {
          return { success: true, data: undefined }
        }
        return { success: true, data: { path: '/', entries: [] } }
      })

      const connectPromise = useFtpStore.getState().connect(CONFIG)
      await useFtpStore.getState().disconnect(KEY)
      resolveConnect!({ success: true, data: undefined })

      await expect(connectPromise).resolves.toBe(false)
      expect(useFtpStore.getState().connections[KEY]).toMatchObject({
        status: 'disconnected',
        error: null
      })
      expect(channels()).not.toContain('ftp:list')
    })

    it('does not apply a list result that finishes after disconnect', async () => {
      let resolveList: ((value: unknown) => void) | undefined
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ftp:connect') {
          return { success: true, data: undefined }
        }
        if (channel === 'ftp:list') {
          return new Promise((resolve) => {
            resolveList = resolve
          })
        }
        if (channel === 'ftp:disconnect') {
          return { success: true, data: undefined }
        }
        return { success: true, data: undefined }
      })

      const connectPromise = useFtpStore.getState().connect(CONFIG)
      await vi.waitFor(() => expect(channels()).toContain('ftp:list'))
      await useFtpStore.getState().disconnect(KEY)
      resolveList!({
        success: true,
        data: {
          path: '/',
          entries: [
            {
              name: 'late.txt',
              type: 'file',
              size: 1,
              modifiedAt: '',
              rawModifiedAt: '',
              isImage: false
            }
          ]
        }
      })

      await expect(connectPromise).resolves.toBe(false)
      expect(useTabsStore.getState().tabs).toEqual([])
      expect(useListingStore.getState().byKey).toEqual({})
    })

    it('does not surface the cancelled connect as an error', async () => {
      let resolveConnect: ((value: { success: false; error: string }) => void) | undefined
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'ftp:connect') {
          return new Promise((resolve) => {
            resolveConnect = resolve
          })
        }
        if (channel === 'ftp:disconnect') {
          return { success: true, data: undefined }
        }
        return { success: true, data: undefined }
      })

      const connectPromise = useFtpStore.getState().connect(CONFIG)
      await useFtpStore.getState().disconnect(KEY)
      resolveConnect!({ success: false, error: 'Connection cancelled' })

      await expect(connectPromise).resolves.toBe(false)
      expect(useFtpStore.getState().connections[KEY].error).toBeNull()
    })
  })
})
