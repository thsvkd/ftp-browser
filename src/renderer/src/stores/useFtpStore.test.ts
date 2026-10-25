import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useFtpStore } from './useFtpStore'
import { useListingStore } from './useListingStore'
import { useTabsStore } from './useTabsStore'
import { useServerStore } from './useServerStore'
import { emptyDraft } from '@renderer/lib/serverAddress'
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
    sessions: {},
    primaryServer: null
  })
  useTabsStore.setState({ tabs: [], activeId: '', recent: [] })
  useListingStore.setState({ byKey: {} })
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
    expect(useTabsStore.getState().tabs.map((t) => t.loc.path)).toEqual(['/photos'])
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
      await useFtpStore.getState().disconnect()
      resolveConnect!({ success: false, error: 'Connection cancelled' })

      await expect(connectPromise).resolves.toBe(false)
      expect(useFtpStore.getState().error).toBeNull()
    })
  })

  const keyA = 'user@ftp.example.com:21'
  const keyB = 'bob@b.example.com:21'

  /** 연결·목록·최근 서버 조회를 모두 성공으로 돌려주는 목. */
  function mockHappyPath(): void {
    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'ftp:connect') return { success: true, data: undefined }
      if (channel === 'ftp:list') return { success: true, data: { path: args[0], entries: [] } }
      if (channel === 'ftp:getRecentPaths' || channel === 'ftp:getRecentServers')
        return { success: true, data: [] }
      return { success: true, data: undefined }
    })
  }

  it('keeps both sessions connected when a second server connects', async () => {
    // covers: Test-914
    mockHappyPath()
    await useFtpStore.getState().connect(CONFIG)
    await useFtpStore.getState().connect({ ...CONFIG, host: 'b.example.com', user: 'bob' })

    const state = useFtpStore.getState()
    expect(state.sessions[keyA]).toMatchObject({ status: 'connected' })
    expect(state.sessions[keyB]).toMatchObject({ status: 'connected' })
    // 투영은 가장 최근에 시도한 세션을 가리킨다(M6)
    expect(state.host).toBe('b.example.com')

    // 태그된 오류는 자기 세션만 바꾼다 — 한 세션이 다른 세션을 덮지 않는다(함정 D)
    useFtpStore.getState().setConnectionState({
      status: 'error',
      host: 'b.example.com',
      error: 'nope',
      server: keyB
    })
    const after = useFtpStore.getState()
    expect(after.sessions[keyA]).toMatchObject({ status: 'connected' })
    expect(after.sessions[keyB]).toMatchObject({ status: 'error', error: 'nope' })
    expect(after.connectionStatus).toBe('error')
    expect(after.error).toBe('nope')
  })

  it('connects to another server without disconnecting the existing session', async () => {
    // covers: Test-916
    mockHappyPath()
    await useFtpStore.getState().connect(CONFIG)
    // 연결 완료 이벤트를 흉내 내어 A가 연결된 상태를 만든다
    useFtpStore.getState().setConnectionState({ status: 'connected', host: CONFIG.host })

    useServerStore.setState({
      draft: {
        ...emptyDraft(),
        host: 'b.example.com',
        port: '21',
        username: 'bob',
        password: 'pw'
      }
    })
    const ok = await useServerStore.getState().connect()

    // 함정 C: 새 서버에 연결해도 기존 세션을 끊지 않는다
    expect(ok).toBe(true)
    expect(mockInvoke.mock.calls.map((c) => c[0])).not.toContain('ftp:disconnect')
    expect(useFtpStore.getState().sessions[keyA]).toMatchObject({ status: 'connected' })
    expect(useFtpStore.getState().sessions[keyB]).toMatchObject({ status: 'connected' })
  })
})
