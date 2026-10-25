/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { en } from '@renderer/i18n/locales/en'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { fromFtpEntry } from '@renderer/lib/explorerEntry'
import { emptyDraft } from '@renderer/lib/serverAddress'
import { invokeCalls } from '@renderer/test/rendererTestUtils'
import { GHOST_ID, useDnd } from '@renderer/components/explorer/dnd'
import { AppShell } from '@renderer/components/layout/AppShell'
import {
  activeTab,
  flush,
  ftp,
  localLoc,
  server,
  setupExplorer,
  type ExplorerHarness
} from '@renderer/components/explorer/explorerTestHarness'
import type { FtpServer } from '@shared/types/ftp'
import { Sidebar } from './Sidebar'

const HOME = 'C:\\Users\\me'

const OFFICE: FtpServer = {
  id: 2,
  name: 'Office',
  host: 'ftp.office.lan',
  port: 2121,
  username: 'kim',
  hasPassword: true,
  secure: true
}
const NAS: FtpServer = {
  id: 3,
  name: 'NAS',
  host: 'nas.local',
  port: 21,
  username: 'me',
  hasPassword: false,
  secure: false
}
/** 익명(빈 아이디) 저장 서버: 저장된 비밀번호가 없는 게 정상이다. */
const ANON: FtpServer = {
  id: 4,
  name: 'Public',
  host: 'files.example.com',
  port: 21,
  username: '',
  hasPassword: false,
  secure: false
}

let h: ExplorerHarness
beforeEach(() => {
  vi.clearAllMocks()
  h = setupExplorer({ connected: false })
  // 장소는 모듈이 한 번만 묻고 기억한다. 이 파일의 모든 테스트가 같은 답을 쓴다.
  h.handlers['local:getPlaces'] = () => ({
    success: true,
    data: {
      home: HOME,
      desktop: `${HOME}\\Desktop`,
      downloads: `${HOME}\\Downloads`,
      documents: null,
      pictures: `${HOME}\\Pictures`,
      music: null,
      videos: null,
      roots: ['C:\\', 'D:\\']
    }
  })
  useServerStore.setState({
    servers: [OFFICE, NAS],
    draft: emptyDraft(),
    address: '',
    connecting: false,
    error: ''
  })
})
afterEach(() => {
  cleanup()
  h.restore()
})

const nav = (): HTMLElement => screen.getByRole('navigation', { name: en['sidebar.label'] })
const place = (name: string | RegExp): HTMLElement => within(nav()).getByRole('button', { name })

/** ftp:connect까지 이르는 비동기 흐름(마이크로태스크·타이머)을 모두 비운다. */
const drain = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('Sidebar — this PC and recent', () => {
  it('lists the places that exist and the drives, navigates, opens tabs and marks the current one', async () => {
    // covers: Test-820
    useTabsStore.getState().openTab(localLoc(`${HOME}\\Desktop`))
    render(<Sidebar />)
    await flush()

    expect(place('Desktop').getAttribute('aria-current')).toBe('location')
    expect(place('Downloads').getAttribute('aria-current')).toBeNull()
    expect(place('Pictures')).toBeTruthy()
    expect(place('Local disk (C:)')).toBeTruthy()
    expect(place('Local disk (D:)')).toBeTruthy()
    for (const missing of ['Documents', 'Music', 'Videos'])
      expect(within(nav()).queryByRole('button', { name: missing })).toBeNull()

    fireEvent.click(place('Downloads'))
    expect(activeTab().loc).toEqual(localLoc(`${HOME}\\Downloads`))
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(place('Downloads').getAttribute('aria-current')).toBe('location')

    // Ctrl+클릭은 새 탭(활성), 가운데 클릭은 뒤에 새 탭
    fireEvent.click(place('Pictures'), { ctrlKey: true })
    expect(useTabsStore.getState().tabs).toHaveLength(2)
    expect(activeTab().loc).toEqual(localLoc(`${HOME}\\Pictures`))
    fireEvent(place('Local disk (D:)'), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(useTabsStore.getState().tabs.map((t) => t.loc.path)).toEqual([
      `${HOME}\\Downloads`,
      `${HOME}\\Pictures`,
      'D:\\'
    ])
    expect(activeTab().loc.path).toBe(`${HOME}\\Pictures`)
  })

  it('shows at most five recent locations', async () => {
    // covers: Test-820
    useTabsStore.getState().openTab(localLoc(HOME))
    useTabsStore.setState({
      recent: [1, 2, 3, 4, 5, 6].map((n) => localLoc(`C:\\work\\r${n}`))
    })
    render(<Sidebar />)
    await flush()
    expect(within(nav()).getByText(en['sidebar.recent'])).toBeTruthy()
    for (const n of [1, 2, 3, 4, 5]) expect(place(`r${n}`)).toBeTruthy()
    expect(within(nav()).queryByRole('button', { name: 'r6' })).toBeNull()
    fireEvent.click(place('r2'))
    expect(activeTab().loc.path).toBe('C:\\work\\r2')
  })
})

describe('Sidebar — servers', () => {
  it('shows the connected server with its status and four recent folders', async () => {
    // covers: Test-821
    useFtpStore.setState({
      connectionStatus: 'connected',
      host: OFFICE.host,
      port: OFFICE.port,
      username: 'kim'
    })
    h.handlers['ftp:getRecentPaths'] = () => ({
      success: true,
      data: ['/a', '/b', '/c', '/d', '/e'].map((path) => ({ path, lastVisited: '' }))
    })
    useTabsStore.getState().openTab(localLoc(HOME))
    render(<Sidebar />)
    await flush()

    expect(invokeCalls(h.invoke, 'ftp:getRecentPaths')).toEqual([[OFFICE.host, OFFICE.port]])
    const office = place(/^Office/)
    expect(office.querySelector('[data-status="connected"]')).toBeTruthy()
    expect(place(/^NAS/).querySelector('[data-status="disconnected"]')).toBeTruthy()
    for (const name of ['a', 'b', 'c', 'd']) expect(place(name)).toBeTruthy()
    expect(within(nav()).queryByRole('button', { name: 'e' })).toBeNull()

    fireEvent.click(place('c'))
    expect(activeTab().loc).toEqual({
      side: 'remote',
      path: '/c',
      server: 'kim@ftp.office.lan:2121'
    })
  })

  it('selects a saved server with a click and connects it with a double-click', async () => {
    // covers: Test-847
    useTabsStore.getState().openTab(localLoc(HOME))
    render(<Sidebar />)
    await flush()
    expect(place(/^NAS/).textContent).toContain(en['sidebar.serverOffline'])

    // 클릭은 선택만: 툴바 주소가 그 서버로 바뀌고 연결은 걸리지 않는다.
    fireEvent.click(place(/^Office/))
    await drain()
    expect(useServerStore.getState().draft.id).toBe(OFFICE.id)
    expect(useServerStore.getState().address).toBe('kim@ftp.office.lan:2121')
    expect(invokeCalls(h.invoke, 'ftp:connect')).toEqual([])

    // 더블클릭이 연결한다.
    fireEvent.click(place(/^Office/))
    fireEvent.doubleClick(place(/^Office/))
    await waitFor(() => expect(invokeCalls(h.invoke, 'ftp:connect')).toHaveLength(1))
    expect(invokeCalls(h.invoke, 'ftp:connect')[0][0]).toMatchObject({
      host: OFFICE.host,
      port: OFFICE.port,
      user: 'kim'
    })
  })

  it('connects an anonymous saved server on double-click', async () => {
    // covers: Test-848
    useServerStore.setState({ servers: [ANON] })
    useTabsStore.getState().openTab(localLoc(HOME))
    render(<Sidebar />)
    await flush()

    fireEvent.doubleClick(place(/^Public/))
    await waitFor(() => expect(invokeCalls(h.invoke, 'ftp:connect')).toHaveLength(1))
    expect(invokeCalls(h.invoke, 'ftp:connect')[0][0]).toMatchObject({
      host: ANON.host,
      port: ANON.port,
      user: 'anonymous'
    })
  })

  it('fills the address and focuses the password field instead of connecting a server without a saved password', async () => {
    // covers: Test-849
    useTabsStore.getState().openTab(localLoc(HOME))
    render(
      <>
        <input type="password" aria-label="toolbar password" />
        <Sidebar />
      </>
    )
    await flush()

    fireEvent.doubleClick(place(/^NAS/))
    await drain()
    expect(invokeCalls(h.invoke, 'ftp:connect')).toEqual([])
    expect(useServerStore.getState().address).toBe('me@nas.local:21')
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('toolbar password'))
    )
  })

  it('moves to the root on a double-click of a connected row instead of connecting', async () => {
    // covers: Test-850
    useFtpStore.setState({
      connectionStatus: 'connected',
      host: OFFICE.host,
      port: OFFICE.port,
      username: 'kim'
    })
    h.handlers['ftp:getRecentPaths'] = () => ({ success: true, data: [] })
    useTabsStore.getState().openTab(localLoc(HOME))
    render(<Sidebar />)
    await flush()

    fireEvent.click(place(/^Office/))
    fireEvent.doubleClick(place(/^Office/))
    await drain()
    expect(invokeCalls(h.invoke, 'ftp:connect')).toEqual([])
    expect(activeTab().loc).toEqual({
      side: 'remote',
      path: '/',
      server: 'kim@ftp.office.lan:2121'
    })
  })

  it('shows the address with the connect hint in an unconnected row title, drop guide first', async () => {
    // covers: Test-851
    useFtpStore.setState({
      connectionStatus: 'connected',
      host: OFFICE.host,
      port: OFFICE.port,
      username: 'kim'
    })
    h.handlers['ftp:getRecentPaths'] = () => ({ success: true, data: [] })
    useTabsStore.getState().openTab(localLoc(HOME))
    render(<Sidebar />)
    await flush()

    const nas = place(/^NAS/)
    expect(nas.getAttribute('title')).toBe(`nas.local:21 · ${en['servers.hint']}`)

    // 끌어온 항목이 연결된 행 위에 있으면 주소 대신 드롭 안내가 보인다.
    const office = place(/^Office/)
    expect(office.getAttribute('title')).toBe('ftp.office.lan:2121')
    act(() =>
      useDnd.setState({
        items: [fromFtpEntry(ftp('x.jpg'), '/photos', server())],
        over: null,
        thumbs: []
      })
    )
    fireEvent.dragOver(office, { dataTransfer: { types: [], files: [], dropEffect: '' } })
    expect(office.getAttribute('title')).toBe('Move 1 → Office')
  })

  it('drags a saved server row with its own ghost, apart from entry drags', async () => {
    // covers: Test-922
    useTabsStore.getState().openTab(localLoc(HOME))
    // 고스트는 탐색기 안에 그려져 있으니 앱 전체를 그린다(저장 서버 목록도 마운트 때 그대로 유지된다).
    h.handlers['ftp:getRecentServers'] = () => ({ success: true, data: [OFFICE, NAS] })
    render(<AppShell />)
    await flush()

    const dt = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: '',
      dropEffect: '',
      types: [],
      files: []
    }
    fireEvent.dragStart(place(/^NAS/), { dataTransfer: dt })

    // M14: useDnd.server에 서버가 담기고 항목 드래그(items)는 비어 있다.
    const dnd = useDnd.getState()
    expect(dnd.server).toMatchObject({ name: 'NAS', host: 'nas.local', port: 21 })
    expect(dnd.items).toBeNull()

    // 고스트가 뜬다 — 서버 이름과 주소를 보여 주고 setDragImage가 그것을 찍는다.
    const ghost = document.getElementById(GHOST_ID)
    expect(ghost).toBeTruthy()
    expect(ghost?.textContent).toContain('NAS')
    expect(ghost?.textContent).toContain('nas.local:21')
    expect(dt.setDragImage).toHaveBeenCalledWith(ghost, 22, 22)
  })
})
