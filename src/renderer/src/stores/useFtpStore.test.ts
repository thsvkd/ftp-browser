import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useFtpStore } from './useFtpStore'
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

function resetStore(): void {
  useFtpStore.setState({
    connectionStatus: 'disconnected',
    host: '',
    port: 21,
    error: null,
    currentPath: '/',
    entries: [],
    loading: false,
    history: ['/'],
    historyIndex: 0
  })
}

describe('useFtpStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
  })

  it('connects and lists the initial path', async () => {
    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'ftp:connect') return { success: true, data: undefined }
      if (channel === 'ftp:list') {
        return { success: true, data: { path: args[0], entries: [] } }
      }
      return { success: true, data: undefined }
    })

    await expect(useFtpStore.getState().connect(CONFIG, '/photos')).resolves.toBe(true)
    const state = useFtpStore.getState()
    expect(state.host).toBe('ftp.example.com')
    expect(state.currentPath).toBe('/photos')
    expect(mockInvoke.mock.calls.map((c) => c[0])).toEqual(['ftp:connect', 'ftp:list'])
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
      await useFtpStore.getState().disconnect()
      resolveConnect!({ success: true, data: undefined })

      await expect(connectPromise).resolves.toBe(false)
      const state = useFtpStore.getState()
      expect(state.host).toBe('')
      expect(state.connectionStatus).toBe('disconnected')
      expect(state.error).toBeNull()
      expect(mockInvoke.mock.calls.map((c) => c[0])).not.toContain('ftp:list')
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
      await vi.waitFor(() => expect(mockInvoke.mock.calls.map((c) => c[0])).toContain('ftp:list'))
      await useFtpStore.getState().disconnect()
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
      expect(useFtpStore.getState().entries).toEqual([])
      expect(useFtpStore.getState().loading).toBe(false)
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
      await useFtpStore.getState().disconnect()
      resolveConnect!({ success: false, error: 'Connection cancelled' })

      await expect(connectPromise).resolves.toBe(false)
      expect(useFtpStore.getState().error).toBeNull()
    })
  })
})
