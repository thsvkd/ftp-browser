/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useListingStore } from '@renderer/stores/useListingStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { locKey, type Loc } from '@renderer/lib/explorerEntry'
import { emptyDraft } from '@renderer/lib/serverAddress'
import type { FtpServer } from '@shared/types/ftp'
import { useAgentSync } from './useAgentSync'

const mockInvoke = vi.fn()
const listeners = new Map<string, (...args: unknown[]) => void>()

const OFFICE: FtpServer = {
  id: 2,
  name: 'Office',
  host: 'ftp.office.lan',
  port: 2121,
  username: 'kim',
  hasPassword: true,
  secure: true
}

/** main이 보낸 것처럼 이벤트 하나를 흘려보낸다. */
function emit(channel: string, payload: unknown): void {
  const listener = listeners.get(channel)
  if (!listener) throw new Error(`nobody listens to ${channel}`)
  listener(payload)
}

const SERVER = 'me@nas.local:21'
const OFFICE_KEY = 'kim@ftp.office.lan:2121'
const remote = (path: string): Loc => ({ side: 'remote', path, server: SERVER })

/** 그 경로를 보는 원격 탭을 연다. 탭 id를 돌려준다. */
const openRemote = (path: string, activate = true): string =>
  useTabsStore.getState().openTab(remote(path), activate)

const tabPath = (id: string): string | undefined =>
  useTabsStore.getState().tabs.find((tab) => tab.id === id)?.loc.path

beforeEach(() => {
  vi.clearAllMocks()
  listeners.clear()
  mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
    if (channel === 'ftp:list') {
      return Promise.resolve({ success: true, data: { path: args[1], entries: [] } })
    }
    if (channel === 'ftp:getRecentServers')
      return Promise.resolve({ success: true, data: [OFFICE] })
    return Promise.resolve({ success: true, data: undefined })
  })
  const api = makeApiMock(mockInvoke)
  api.on.mockImplementation((channel: string, callback: (...args: unknown[]) => void) => {
    listeners.set(channel, callback)
    return () => listeners.delete(channel)
  })
  vi.stubGlobal('api', api)
  useFtpStore.setState({
    connections: {
      [SERVER]: { status: 'connected', host: 'nas.local', port: 21, user: 'me', error: null }
    }
  })
  useTabsStore.setState({ tabs: [], activeId: '', recent: [] })
  useListingStore.setState({ byKey: {} })
  useServerStore.setState({
    servers: [],
    draft: emptyDraft(),
    address: '',
    connecting: false,
    error: ''
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useAgentSync — remote changes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('re-reads a listed folder once after a burst of changes inside it, never other folders', async () => {
    // covers: Test-500
    renderHook(() => useAgentSync())
    useListingStore.getState().put(remote('/photos'), [])
    useListingStore.getState().put(remote('/other'), [])

    emit('ftp:remoteChanged', { server: SERVER, kind: 'upload', remotePath: '/photos/a.jpg' })
    emit('ftp:remoteChanged', { server: SERVER, kind: 'mkdir', remotePath: '/photos/new' })
    await vi.advanceTimersByTimeAsync(299)
    expect(invokeCalls(mockInvoke, 'ftp:list')).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(invokeCalls(mockInvoke, 'ftp:list')).toEqual([[SERVER, '/photos']])

    // 읽은 적 없는 폴더는 다시 읽지 않는다. 같은 이름으로 시작하는 형제 폴더도 다른 폴더다.
    emit('ftp:remoteChanged', { server: SERVER, kind: 'upload', remotePath: '/photos-old/x.jpg' })
    emit('ftp:remoteChanged', {
      server: SERVER,
      kind: 'delete',
      remotePath: '/photos/sub/deep.jpg'
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(invokeCalls(mockInvoke, 'ftp:list')).toHaveLength(1)

    // 다른 폴더에서 옮겨 온 것은 양쪽 폴더를 다시 읽는다.
    emit('ftp:remoteChanged', {
      server: SERVER,
      kind: 'rename',
      remotePath: '/other/b.jpg',
      newPath: '/photos/b.jpg'
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(invokeCalls(mockInvoke, 'ftp:list')).toEqual([
      [SERVER, '/photos'],
      [SERVER, '/other'],
      [SERVER, '/photos']
    ])
  })

  it('moves a tab up when its folder (or one above it) is deleted or renamed', async () => {
    // covers: Test-501
    renderHook(() => useAgentSync())
    const id = openRemote('/photos/2024')

    emit('ftp:remoteChanged', { server: SERVER, kind: 'delete', remotePath: '/photos/2024' })
    await vi.advanceTimersByTimeAsync(300)
    expect(tabPath(id)).toBe('/photos')

    useTabsStore.getState().navigate(remote('/photos/2024'))
    emit('ftp:remoteChanged', {
      server: SERVER,
      kind: 'rename',
      remotePath: '/photos/2024',
      newPath: '/photos/2025'
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(tabPath(id)).toBe('/photos')

    useTabsStore.getState().navigate(remote('/a/b/c'))
    emit('ftp:remoteChanged', { server: SERVER, kind: 'delete', remotePath: '/a/b' })
    await vi.advanceTimersByTimeAsync(300)
    expect(tabPath(id)).toBe('/a')
  })

  it('moves inactive remote tabs up too, and points a remote tab at an agent session without switching tabs (D3)', async () => {
    // covers: Test-829
    renderHook(() => useAgentSync())
    const background = openRemote('/photos/2024/05')
    const other = useTabsStore
      .getState()
      .openTab({ side: 'remote', path: '/photos/2024', server: 'kim@ftp.office.lan:2121' })
    const local = useTabsStore.getState().openTab({ side: 'local', path: '/photos/2024' })

    emit('ftp:remoteChanged', { server: SERVER, kind: 'delete', remotePath: '/photos/2024' })
    await vi.advanceTimersByTimeAsync(300)

    expect(tabPath(background)).toBe('/photos')
    expect(tabPath(other)).toBe('/photos/2024')
    expect(tabPath(local)).toBe('/photos/2024')
    expect(useTabsStore.getState().activeId).toBe(local)

    // 에이전트 연결: 그 서버의 첫 원격 탭이 그 폴더로 간다. 활성 탭(로컬)은 그대로다.
    emit('agent:session', {
      server: OFFICE_KEY,
      status: 'connected',
      host: 'ftp.office.lan',
      port: 2121,
      user: 'kim'
    })
    const s = useTabsStore.getState()
    expect(s.activeId).toBe(local)
    expect(s.tabs.map((tab) => tab.loc)).toEqual([
      { side: 'remote', path: '/photos', server: SERVER },
      { side: 'remote', path: '/', server: OFFICE_KEY },
      { side: 'local', path: '/photos/2024' }
    ])
    await vi.advanceTimersByTimeAsync(0)
  })

  it('drops a re-read that returns after a newer one for the same folder', async () => {
    // covers: Test-519
    // 동기화로 다시 읽기가 잦아지면, 늦게 온 이전 목록이 새 목록을 덮어쓸 수 있다.
    const pending: Array<(value: unknown) => void> = []
    const listing = (path: string, name: string): unknown => ({
      success: true,
      data: { path, entries: [{ name, type: 'file', size: 1, modifiedAt: '' }] }
    })
    mockInvoke.mockImplementation(
      (channel: string) =>
        new Promise((resolve) => {
          if (channel === 'ftp:list') pending.push(resolve)
          else resolve({ success: true, data: undefined })
        })
    )
    renderHook(() => useAgentSync())
    useListingStore.getState().put(remote('/photos'), [])

    emit('ftp:remoteChanged', { server: SERVER, kind: 'upload', remotePath: '/photos/a.jpg' })
    await vi.advanceTimersByTimeAsync(300)
    emit('ftp:remoteChanged', { server: SERVER, kind: 'upload', remotePath: '/photos/b.jpg' })
    await vi.advanceTimersByTimeAsync(300)
    pending[1](listing('/photos', 'b.jpg'))
    await vi.advanceTimersByTimeAsync(0)
    pending[0](listing('/photos', 'a.jpg'))
    await vi.advanceTimersByTimeAsync(0)
    const entries = useListingStore.getState().byKey[locKey(remote('/photos'))]?.entries
    expect(entries?.map((e) => e.name)).toEqual(['b.jpg'])
  })

  it('ignores remote changes while not connected', async () => {
    renderHook(() => useAgentSync())
    const id = openRemote('/photos/2024')
    useListingStore.getState().put(remote('/photos'), [])
    useFtpStore.getState().adoptSession({ server: SERVER, status: 'disconnected' })

    emit('ftp:remoteChanged', { server: SERVER, kind: 'delete', remotePath: '/photos/2024' })
    await vi.advanceTimersByTimeAsync(300)

    expect(invokeCalls(mockInvoke, 'ftp:list')).toEqual([])
    expect(tabPath(id)).toBe('/photos/2024')
  })
})

describe('useAgentSync — agent sessions', () => {
  it('follows an agent connect: reloads servers, points the toolbar at it and a remote tab at its folder', async () => {
    // covers: Test-503
    renderHook(() => useAgentSync())

    emit('agent:session', {
      server: OFFICE_KEY,
      status: 'connected',
      serverId: 2,
      host: 'ftp.office.lan',
      port: 2121,
      user: 'kim',
      path: '/media'
    })

    expect(useTabsStore.getState().tabs.map((tab) => tab.loc)).toEqual([
      { side: 'remote', path: '/media', server: 'kim@ftp.office.lan:2121' }
    ])
    expect(invokeCalls(mockInvoke, 'ftp:getRecentServers')).toHaveLength(1)
    await waitFor(() => expect(useServerStore.getState().draft.id).toBe(2))
    expect(useServerStore.getState().address).toBe('kim@ftp.office.lan:2121')
    expect(useFtpStore.getState().connections[OFFICE_KEY]).toMatchObject({
      status: 'connected',
      host: 'ftp.office.lan',
      port: 2121,
      user: 'kim'
    })
    // main이 이미 연결했으므로 렌더러가 다시 연결하지 않는다.
    expect(invokeCalls(mockInvoke, 'ftp:connect')).toEqual([])

    // 해제는 그 서버만 끊긴 것으로 둔다(다른 연결은 그대로). main은 이미 끊었으므로 다시 끊으라고
    // 보내지 않는다(그 사이 에이전트가 다시 연결했으면 늦게 도착한 ftp:disconnect가 그 세션을 끊는다).
    emit('agent:session', { server: OFFICE_KEY, status: 'disconnected' })
    expect(useFtpStore.getState().connections[OFFICE_KEY].status).toBe('disconnected')
    expect(useFtpStore.getState().connections[SERVER].status).toBe('connected')
    expect(invokeCalls(mockInvoke, 'ftp:disconnect')).toEqual([])
  })

  it('leaves the GUI alone while the user is connecting by themselves', async () => {
    // covers: Test-516
    renderHook(() => useAgentSync())
    const id = openRemote('/photos')
    useServerStore.setState({ connecting: true })

    emit('agent:session', {
      server: OFFICE_KEY,
      status: 'connected',
      serverId: 2,
      host: 'ftp.office.lan',
      port: 2121
    })
    emit('agent:session', { server: OFFICE_KEY, status: 'disconnected' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(invokeCalls(mockInvoke, 'ftp:getRecentServers')).toEqual([])
    expect(useServerStore.getState().draft).toEqual(emptyDraft())
    expect(Object.keys(useFtpStore.getState().connections)).toEqual([SERVER])
    expect(useFtpStore.getState().connections[SERVER]).toMatchObject({
      status: 'connected',
      host: 'nas.local'
    })
    expect(tabPath(id)).toBe('/photos')
  })
})
