import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyDraft, type ServerDraft } from '@renderer/lib/serverAddress'
import { en } from '@renderer/i18n/locales/en'
import { useFtpStore, type ConnInfo } from './useFtpStore'
import { useListingStore } from './useListingStore'
import { useServerStore } from './useServerStore'
import { useSettingsStore } from './useSettingsStore'
import { useTabsStore } from './useTabsStore'
import type { FtpConnectPayload } from '@shared/types/ftp'

const invoke = vi.fn()
vi.stubGlobal('window', { api: { invoke } })

const A = 'alice@a.example.com:21'
const B = 'bob@b.example.com:2121'
const A_INFO: ConnInfo = {
  status: 'connected',
  host: 'a.example.com',
  port: 21,
  user: 'alice',
  error: null
}
const DRAFT_B: ServerDraft = {
  ...emptyDraft(),
  host: 'b.example.com',
  port: '2121',
  username: 'bob',
  password: 'pw',
  path: '/'
}

type Handler = (...args: unknown[]) => unknown
function mockIpc(overrides: Record<string, Handler> = {}): void {
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (overrides[channel]) return overrides[channel](...args)
    if (channel === 'ftp:list') return { success: true, data: { path: args[1], entries: [] } }
    if (channel === 'ftp:getRecentServers' || channel === 'ftp:getRecentPaths')
      return { success: true, data: [] }
    return { success: true, data: undefined }
  })
}

const callsOf = (channel: string): unknown[][] =>
  invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c.slice(1))

beforeEach(() => {
  useSettingsStore.setState({ language: 'en' })
  invoke.mockReset()
  mockIpc()
  useFtpStore.setState({ connections: { [A]: A_INFO } })
  useServerStore.setState({
    servers: [],
    draft: emptyDraft(),
    address: '',
    connecting: false,
    error: ''
  })
  useTabsStore.setState({ tabs: [], activeId: '', recent: [] })
  useListingStore.setState({ byKey: {} })
})

describe('useServerStore.connect with several connections', () => {
  it('adds a toolbar connect next to the connected server, and Cancel ends only the attempt', async () => {
    // covers: Test-1013
    await expect(useServerStore.getState().connect(DRAFT_B)).resolves.toBe(true)
    expect(callsOf('ftp:disconnect')).toEqual([])
    expect((callsOf('ftp:connect')[0][0] as FtpConnectPayload).host).toBe('b.example.com')
    const { connections } = useFtpStore.getState()
    expect(connections[A].status).toBe('connected')
    expect(connections[B].status).toBe('connected')

    // 연결 중 cancel()은 그 시도의 키만 끊는다
    useFtpStore.setState({ connections: { [A]: A_INFO } })
    invoke.mockReset()
    mockIpc({ 'ftp:connect': () => new Promise(() => undefined) })
    void useServerStore.getState().connect(DRAFT_B)
    await vi.waitFor(() => expect(callsOf('ftp:connect')).toHaveLength(1))
    useServerStore.getState().cancel()
    expect(callsOf('ftp:disconnect')).toEqual([[B]])
    expect(useServerStore.getState().connecting).toBe(false)
  })

  it("shows the failed server's own error, not another connection's", async () => {
    // covers: Test-1036
    useFtpStore.setState({
      connections: { [A]: { ...A_INFO, status: 'error', error: 'A broke' } }
    })
    mockIpc({ 'ftp:connect': () => ({ success: false, error: '530 Login incorrect' }) })
    await expect(useServerStore.getState().connect(DRAFT_B)).resolves.toBe(false)
    expect(useServerStore.getState().error).toBe('530 Login incorrect')

    // 실패의 오류가 비어 있으면 일반 문구
    useServerStore.setState({ error: '' })
    mockIpc({ 'ftp:connect': () => ({ success: false, error: '' }) })
    await expect(useServerStore.getState().connect(DRAFT_B)).resolves.toBe(false)
    expect(useServerStore.getState().error).toBe(en['connect.failed'])
  })

  it("asks the recent folders of the account it connects as, not the saved row's", async () => {
    // covers: Test-1152
    const RA = 'ra@127.0.0.1:2121'
    const RB2 = 'rb2@127.0.0.1:2121'
    useFtpStore.setState({ connections: {} })
    useServerStore.setState({
      servers: [
        {
          id: 1,
          name: '',
          host: '127.0.0.1',
          port: 2121,
          username: 'ra',
          hasPassword: false,
          secure: false
        }
      ]
    })
    const draft = (username: string): ServerDraft => ({
      ...emptyDraft(),
      id: 1,
      host: '127.0.0.1',
      port: '2121',
      username,
      password: 'pw'
    })
    const recent: Record<string, string[]> = { [RA]: ['/photos'] }
    const connectAs = async (username: string): Promise<unknown[][]> => {
      invoke.mockClear()
      useFtpStore.setState({ connections: {} })
      mockIpc({
        'ftp:getRecentPaths': (key) => ({
          success: true,
          data: (recent[key as string] ?? []).map((path) => ({ path, lastVisited: '' }))
        })
      })
      await expect(useServerStore.getState().connect(draft(username))).resolves.toBe(true)
      return callsOf('ftp:getRecentPaths')
    }

    // 다른 계정으로 연결: 그 계정의 키로 묻고, 기록이 없으면 RA의 /photos가 아니라 / 에서 연다
    expect(await connectAs('rb2')).toEqual([[RB2]])
    expect(callsOf('ftp:list')).toEqual([[RB2, '/']])

    recent[RB2] = ['/inbox']
    expect(await connectAs('rb2')).toEqual([[RB2]])
    expect(callsOf('ftp:list')).toEqual([[RB2, '/inbox']])

    // 저장된 계정 그대로 연결하면 저장된 키로 묻는다
    expect(await connectAs('ra')).toEqual([[RA]])
    expect(callsOf('ftp:list')).toEqual([[RA, '/photos']])
  })
})
