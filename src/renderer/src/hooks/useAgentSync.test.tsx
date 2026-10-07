/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { useServerStore } from '@renderer/stores/useServerStore'
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

beforeEach(() => {
  vi.clearAllMocks()
  listeners.clear()
  mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
    if (channel === 'ftp:list' || channel === 'local:list') {
      return Promise.resolve({ success: true, data: { path: args[0], entries: [] } })
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
    connectionStatus: 'connected',
    host: 'nas.local',
    port: 21,
    error: null,
    currentPath: '/photos',
    entries: [],
    loading: false,
    history: ['/', '/photos'],
    historyIndex: 1
  })
  useLocalFsStore.setState({
    currentPath: 'C:\\work',
    entries: [],
    loading: false,
    error: null,
    history: ['C:\\work'],
    historyIndex: 0
  })
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

  it('refreshes the current folder once after a burst of changes inside it, never for others', async () => {
    // covers: Test-500
    renderHook(() => useAgentSync())

    emit('ftp:remoteChanged', { kind: 'upload', remotePath: '/photos/a.jpg' })
    emit('ftp:remoteChanged', { kind: 'mkdir', remotePath: '/photos/new' })
    await vi.advanceTimersByTimeAsync(299)
    expect(invokeCalls(mockInvoke, 'ftp:list')).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(invokeCalls(mockInvoke, 'ftp:list')).toEqual([['/photos']])

    // 다른 폴더의 변경은 목록을 다시 읽지 않는다. 같은 이름으로 시작하는 형제 폴더도 다른 폴더다.
    emit('ftp:remoteChanged', { kind: 'upload', remotePath: '/other/x.jpg' })
    emit('ftp:remoteChanged', { kind: 'upload', remotePath: '/photos-old/x.jpg' })
    emit('ftp:remoteChanged', { kind: 'delete', remotePath: '/photos/sub/deep.jpg' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(invokeCalls(mockInvoke, 'ftp:list')).toHaveLength(1)

    // 다른 폴더에서 현재 폴더로 옮겨 온 것은 newPath의 부모로 판단한다.
    emit('ftp:remoteChanged', {
      kind: 'rename',
      remotePath: '/other/b.jpg',
      newPath: '/photos/b.jpg'
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(invokeCalls(mockInvoke, 'ftp:list')).toEqual([['/photos'], ['/photos']])
  })

  it('moves up when the current folder (or one above it) is deleted or renamed', async () => {
    // covers: Test-501
    renderHook(() => useAgentSync())
    useFtpStore.setState({ currentPath: '/photos/2024' })

    emit('ftp:remoteChanged', { kind: 'delete', remotePath: '/photos/2024' })
    await vi.advanceTimersByTimeAsync(300)
    expect(useFtpStore.getState().currentPath).toBe('/photos')

    useFtpStore.setState({ currentPath: '/photos/2024' })
    emit('ftp:remoteChanged', {
      kind: 'rename',
      remotePath: '/photos/2024',
      newPath: '/photos/2025'
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(useFtpStore.getState().currentPath).toBe('/photos')

    useFtpStore.setState({ currentPath: '/a/b/c' })
    emit('ftp:remoteChanged', { kind: 'delete', remotePath: '/a/b' })
    await vi.advanceTimersByTimeAsync(300)
    expect(useFtpStore.getState().currentPath).toBe('/a')
    expect(invokeCalls(mockInvoke, 'ftp:list')).toEqual([['/photos'], ['/photos'], ['/a']])

    // 로컬 패널도 같다. Windows 경로는 대소문자와 구분자를 가리지 않고, 이동할 곳은 패널이 쓰던 표기를 따른다.
    useLocalFsStore.setState({ currentPath: 'C:\\work\\old\\sub' })
    emit('local:changed', { paths: ['c:/WORK/old/'] })
    await vi.advanceTimersByTimeAsync(300)
    expect(useLocalFsStore.getState().currentPath).toBe('C:\\work')

    useLocalFsStore.setState({ currentPath: 'C:\\work' })
    emit('local:changed', { paths: ['C:\\work'] })
    await vi.advanceTimersByTimeAsync(300)
    expect(useLocalFsStore.getState().currentPath).toBe('C:\\')
  })

  it('drops a refresh that returns after the user already moved to another folder', async () => {
    // covers: Test-519
    // 동기화로 새로 고침이 잦아지면, 이동하는 사이 늦게 온 이전 폴더 목록이 새 폴더를 덮어쓸 수 있다.
    const pending: Array<(value: unknown) => void> = []
    const listing = (path: string, name: string): unknown => ({
      success: true,
      data: { path, entries: [{ name }] }
    })
    mockInvoke.mockImplementation(
      (channel: string) =>
        new Promise((resolve) => {
          if (channel === 'ftp:list' || channel === 'local:list') pending.push(resolve)
          else resolve({ success: true, data: undefined })
        })
    )
    renderHook(() => useAgentSync())

    emit('ftp:remoteChanged', { kind: 'upload', remotePath: '/photos/a.jpg' })
    await vi.advanceTimersByTimeAsync(300)
    const navigating = useFtpStore.getState().navigateTo('/photos/2024')
    pending[1](listing('/photos/2024', 'inside-2024.jpg'))
    await navigating
    pending[0](listing('/photos', 'a.jpg'))
    await vi.advanceTimersByTimeAsync(0)
    expect(useFtpStore.getState()).toMatchObject({
      currentPath: '/photos/2024',
      entries: [{ name: 'inside-2024.jpg' }]
    })

    emit('local:changed', { paths: ['C:\\work\\b.txt'] })
    await vi.advanceTimersByTimeAsync(300)
    const moving = useLocalFsStore.getState().navigateTo('C:\\other')
    pending[3](listing('C:\\other', 'other.txt'))
    await moving
    pending[2](listing('C:\\work', 'b.txt'))
    await vi.advanceTimersByTimeAsync(0)
    expect(useLocalFsStore.getState()).toMatchObject({
      currentPath: 'C:\\other',
      entries: [{ name: 'other.txt' }]
    })
  })

  it('ignores remote changes while not connected', async () => {
    renderHook(() => useAgentSync())
    useFtpStore.setState({ connectionStatus: 'disconnected' })

    emit('ftp:remoteChanged', { kind: 'upload', remotePath: '/photos/a.jpg' })
    await vi.advanceTimersByTimeAsync(300)

    expect(invokeCalls(mockInvoke, 'ftp:list')).toEqual([])
  })
})

describe('useAgentSync — local changes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('refreshes the local pane when it shows the parent of a changed path', async () => {
    // covers: Test-502
    renderHook(() => useAgentSync())

    emit('local:changed', { paths: ['C:\\work\\new folder', 'C:\\work\\b.txt'] })
    await vi.advanceTimersByTimeAsync(299)
    expect(invokeCalls(mockInvoke, 'local:list')).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(invokeCalls(mockInvoke, 'local:list')).toEqual([['C:\\work']])

    emit('local:changed', { paths: ['D:\\other\\x.txt', 'C:\\work\\sub\\deep.txt'] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(invokeCalls(mockInvoke, 'local:list')).toHaveLength(1)

    useLocalFsStore.setState({ currentPath: '/home/kim/Downloads' })
    emit('local:changed', { paths: ['/home/kim/Downloads/a.jpg'] })
    await vi.advanceTimersByTimeAsync(300)
    expect(invokeCalls(mockInvoke, 'local:list')).toEqual([['C:\\work'], ['/home/kim/Downloads']])
  })
})

describe('useAgentSync — agent sessions', () => {
  it('follows an agent connect: reloads servers, points the toolbar at it and opens its folder', async () => {
    // covers: Test-503
    renderHook(() => useAgentSync())

    emit('agent:session', {
      status: 'connected',
      serverId: 2,
      host: 'ftp.office.lan',
      port: 2121,
      user: 'kim',
      path: '/media'
    })

    await waitFor(() => expect(useFtpStore.getState().currentPath).toBe('/media'))
    expect(invokeCalls(mockInvoke, 'ftp:getRecentServers')).toHaveLength(1)
    await waitFor(() => expect(useServerStore.getState().draft.id).toBe(2))
    expect(useServerStore.getState().address).toBe('kim@ftp.office.lan:2121')
    expect(useFtpStore.getState()).toMatchObject({
      connectionStatus: 'connected',
      host: 'ftp.office.lan',
      port: 2121,
      history: ['/', '/media']
    })
    // main이 이미 연결했으므로 렌더러가 다시 연결하지 않는다.
    expect(invokeCalls(mockInvoke, 'ftp:connect')).toEqual([])

    // 해제는 GUI의 disconnect()와 같은 초기화다. main은 이미 끊었으므로 다시 끊으라고 보내지 않는다
    // (그 사이 에이전트가 다시 연결했으면 늦게 도착한 ftp:disconnect가 그 세션을 끊는다).
    useFtpStore.setState({ entries: [{ name: 'a.jpg' } as never] })
    emit('agent:session', { status: 'disconnected' })
    expect(useFtpStore.getState()).toMatchObject({
      connectionStatus: 'disconnected',
      host: '',
      port: 21,
      currentPath: '/',
      entries: [],
      history: ['/'],
      historyIndex: 0
    })
    expect(invokeCalls(mockInvoke, 'ftp:disconnect')).toEqual([])
  })

  it('opens the root when the agent session names no folder', async () => {
    renderHook(() => useAgentSync())
    emit('agent:session', { status: 'connected', serverId: 2, host: 'ftp.office.lan', port: 2121 })

    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:list')).toEqual([['/']]))
  })

  it('leaves the GUI alone while the user is connecting by themselves', async () => {
    // covers: Test-516
    renderHook(() => useAgentSync())
    useServerStore.setState({ connecting: true })

    emit('agent:session', { status: 'connected', serverId: 2, host: 'ftp.office.lan', port: 2121 })
    emit('agent:session', { status: 'disconnected' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(invokeCalls(mockInvoke, 'ftp:getRecentServers')).toEqual([])
    expect(invokeCalls(mockInvoke, 'ftp:list')).toEqual([])
    expect(useServerStore.getState().draft).toEqual(emptyDraft())
    expect(useFtpStore.getState()).toMatchObject({
      connectionStatus: 'connected',
      currentPath: '/photos'
    })
  })
})
