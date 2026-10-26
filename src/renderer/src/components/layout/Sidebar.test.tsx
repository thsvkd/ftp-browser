/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { en } from '@renderer/i18n/locales/en'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { fromFtpEntry } from '@renderer/lib/explorerEntry'
import { emptyDraft } from '@renderer/lib/serverAddress'
import { invokeCalls } from '@renderer/test/rendererTestUtils'
import {
  activeTab,
  flush,
  ftp,
  localLoc,
  setConnection,
  setupExplorer,
  type ExplorerHarness
} from '@renderer/components/explorer/explorerTestHarness'
import { GHOST_ID, useDnd } from '@renderer/components/explorer/dnd'
import { AppShell } from '@renderer/components/layout/AppShell'
import type { FtpServer } from '@shared/types/ftp'
import { act } from '@testing-library/react'
import { ConnectBar } from '@renderer/components/server/ConnectBar'
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

  it('tells same-named recent folders of two users on one host apart by their source line', async () => {
    // covers: Test-1145
    const RA = 'ra@127.0.0.1:2121'
    const RB2 = 'rb2@127.0.0.1:2121'
    useTabsStore.getState().openTab(localLoc(HOME))
    useTabsStore.setState({
      recent: [
        { side: 'remote', path: '/inbox', server: RA },
        { side: 'remote', path: '/inbox', server: RB2 },
        localLoc('C:\\work\\inbox')
      ]
    })
    render(<Sidebar />)
    await flush()

    const rowA = place(`inbox · ${RA}`)
    const rowB = place(`inbox · ${RB2}`)
    const local = place('inbox')
    expect(rowA.getAttribute('title')).toBe(`${RA} · /inbox`)
    expect(rowB.getAttribute('title')).toBe(`${RB2} · /inbox`)
    expect(within(rowA).getByText(RA)).toBeTruthy()
    expect(within(rowB).getByText(RB2)).toBeTruthy()
    expect(local.textContent).toBe('inbox')

    fireEvent.click(rowB)
    expect(activeTab().loc).toEqual({ side: 'remote', path: '/inbox', server: RB2 })
  })
})

describe('Sidebar — servers', () => {
  it('shows the connected server with its status and four recent folders', async () => {
    // covers: Test-821
    setConnection('kim@ftp.office.lan:2121', 'connected')
    h.handlers['ftp:getRecentPaths'] = () => ({
      success: true,
      data: ['/a', '/b', '/c', '/d', '/e'].map((path) => ({ path, lastVisited: '' }))
    })
    useTabsStore.getState().openTab(localLoc(HOME))
    render(<Sidebar />)
    await flush()

    expect(invokeCalls(h.invoke, 'ftp:getRecentPaths')).toEqual([['kim@ftp.office.lan:2121']])
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
    // covers: Test-1214
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
    // covers: Test-1215
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
    // covers: Test-1216
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
    // covers: Test-1217
    setConnection('kim@ftp.office.lan:2121', 'connected')
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
    // covers: Test-1218
    setConnection('kim@ftp.office.lan:2121', 'connected')
    h.handlers['ftp:getRecentPaths'] = () => ({ success: true, data: [] })
    useTabsStore.getState().openTab(localLoc(HOME))
    render(<Sidebar />)
    await flush()

    const nas = place(/^NAS/)
    expect(nas.getAttribute('title')).toBe(`me@nas.local:21 · ${en['servers.hint']}`)

    // 끌어온 항목이 연결된 행 위에 있으면 주소 대신 드롭 안내가 보인다.
    const office = place(/^Office/)
    expect(office.getAttribute('title')).toBe('kim@ftp.office.lan:2121')
    act(() =>
      useDnd.setState({
        items: [fromFtpEntry(ftp('x.jpg'), '/photos', 'kim@ftp.office.lan:2121')],
        over: null,
        thumbs: []
      })
    )
    fireEvent.dragOver(office, { dataTransfer: { types: [], files: [], dropEffect: '' } })
    expect(office.getAttribute('title')).toBe('Move 1 → Office')
  })

  it('shows a password field for a server without a saved password while a connected tab is active', async () => {
    // covers: Test-1276
    h.handlers['ftp:getRecentServers'] = () => ({ success: true, data: [OFFICE, NAS] })
    h.handlers['ftp:getRecentPaths'] = () => ({ success: true, data: [] })
    setConnection('kim@ftp.office.lan:2121', 'connected')
    useTabsStore
      .getState()
      .openTab({ side: 'remote', path: '/', server: 'kim@ftp.office.lan:2121' })
    // 진짜 툴바: 연결된 탭이면 연결된 표시줄(비밀번호 칸 없음)이 그려진다.
    render(
      <>
        <ConnectBar />
        <Sidebar />
      </>
    )
    await flush()
    expect(document.querySelector('input[type="password"]')).toBeNull()

    fireEvent.doubleClick(place(/^NAS/))
    await drain()
    expect(invokeCalls(h.invoke, 'ftp:connect')).toEqual([])
    await waitFor(() => {
      const password = document.querySelector('input[type="password"]')
      expect(password).toBeTruthy()
      expect(document.activeElement).toBe(password)
    })
    expect(useServerStore.getState().address).toBe('me@nas.local:21')
  })

  it('says double-click or Enter connects in the unconnected and lost row hints', async () => {
    // covers: Test-1278
    setConnection('me@nas.local:21', 'error')
    useTabsStore.getState().openTab(localLoc(HOME))
    render(<Sidebar />)
    await flush()

    for (const key of ['sidebar.serverOffline', 'sidebar.serverLost'] as const) {
      expect(en[key]).toMatch(/double-click/i)
      expect(en[key]).toMatch(/Enter/)
      expect(en[key]).not.toMatch(/(^|[^-])click to/i)
    }
    expect(place(/^Office/).textContent).toContain(en['sidebar.serverOffline'])
    expect(place(/^NAS/).textContent).toContain(en['sidebar.serverLost'])
  })

  it('marks only the clicked server row as selected, and moves it with the next click', async () => {
    // covers: Test-1279
    useTabsStore.getState().openTab(localLoc(HOME))
    render(<Sidebar />)
    await flush()
    const selected = (): string[] =>
      within(nav())
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.textContent ?? '')

    fireEvent.click(place(/^Office/))
    expect(place(/^Office/).getAttribute('aria-pressed')).toBe('true')
    expect(selected()).toHaveLength(1)

    fireEvent.click(place(/^NAS/))
    expect(place(/^NAS/).getAttribute('aria-pressed')).toBe('true')
    expect(place(/^Office/).getAttribute('aria-pressed')).not.toBe('true')
    expect(selected()).toHaveLength(1)
  })

  it('selects a not-connected row on Enter and exposes the selection with a valid ARIA state', async () => {
    // covers: Test-1307
    useTabsStore.getState().openTab(localLoc(HOME))
    render(<Sidebar />)
    await flush()

    const office = place(/^Office/)
    office.focus()
    fireEvent.keyDown(office, { key: 'Enter' })
    await drain()

    // 역할 없는 button의 aria-selected는 유효하지 않다: 버튼 역할이 지원하는 aria-pressed로 보인다
    expect(office.tagName).toBe('BUTTON')
    expect(office.getAttribute('role')).toBeNull()
    expect(office.getAttribute('aria-pressed')).toBe('true')
    expect(place(/^NAS/).getAttribute('aria-pressed')).toBe('false')
    expect(
      within(nav())
        .queryAllByRole('button')
        .some((b) => b.hasAttribute('aria-selected'))
    ).toBe(false)
  })

  it('drags a saved server row with its own ghost, apart from entry drags', async () => {
    // covers: Test-1257
    // 고스트는 화면 밖에 그려져 있고, 실제로는 앱 전체(탐색기·고스트)를 그린다.
    h.handlers['ftp:getRecentServers'] = () => ({ success: true, data: [OFFICE, NAS] })
    useTabsStore.getState().openTab(localLoc(HOME))
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

    // 고스트가 뜨고 서버 이름과 주소를 보여 주며 setDragImage가 그것을 찍는다.
    const ghost = document.getElementById(GHOST_ID)
    expect(ghost).toBeTruthy()
    expect(ghost?.textContent).toContain('NAS')
    expect(ghost?.textContent).toContain('nas.local:21')
    expect(dt.setDragImage).toHaveBeenCalledWith(ghost, 22, 22)
  })
})

describe('Sidebar — several connections', () => {
  const ARCHIVE: FtpServer = {
    id: 4,
    name: 'Archive',
    host: 'archive.lan',
    port: 21,
    username: 'arc',
    hasPassword: false,
    secure: false
  }
  const OFFICE_KEY = 'kim@ftp.office.lan:2121'
  const NAS_KEY = 'me@nas.local:21'
  /** 서버 절의 행 이름(위에서부터). 상태 점이 있는 버튼만 */
  const serverRows = (): string[] =>
    within(nav())
      .getAllByRole('button')
      .filter((b) => b.querySelector('[data-status]'))
      .map((b) => b.textContent ?? '')

  it('gives every server its own dot, recent folders and disconnect button', async () => {
    // covers: Test-1020
    useServerStore.setState({ servers: [OFFICE, NAS, ARCHIVE] })
    setConnection(OFFICE_KEY, 'connected')
    setConnection(NAS_KEY, 'connected')
    setConnection('arc@archive.lan:21', 'error')
    setConnection('x@x.example:21', 'connected')
    setConnection('w@w.example:2121', 'connected')
    const recent: Record<string, string[]> = {
      [OFFICE_KEY]: ['/o1', '/o2', '/o3', '/o4', '/o5'],
      [NAS_KEY]: ['/n1', '/n2', '/n3', '/n4', '/n5']
    }
    h.handlers['ftp:getRecentPaths'] = (key) => ({
      success: true,
      data: (recent[key as string] ?? []).map((path) => ({ path, lastVisited: '' }))
    })
    useTabsStore.getState().openTab(localLoc(HOME))
    render(<Sidebar />)
    await flush()

    expect(place(/^Office/).querySelector('[data-status="connected"]')).toBeTruthy()
    expect(place(/^NAS/).querySelector('[data-status="connected"]')).toBeTruthy()
    // 끊긴(error) C는 연결 안 됨이 아니라 끊김 표시와 다시 연결 안내
    expect(place(/^Archive/).querySelector('[data-status="error"]')).toBeTruthy()
    expect(place(/^Archive/).textContent).toContain(en['sidebar.serverLost'])
    expect(invokeCalls(h.invoke, 'ftp:getRecentPaths')).toEqual(
      expect.arrayContaining([[OFFICE_KEY], [NAS_KEY]])
    )
    for (const name of ['o1', 'o2', 'o3', 'o4', 'n1', 'n2', 'n3', 'n4'])
      expect(place(name)).toBeTruthy()
    for (const name of ['o5', 'n5'])
      expect(within(nav()).queryByRole('button', { name })).toBeNull()
    fireEvent.click(place('n2'))
    expect(activeTab().loc).toEqual({ side: 'remote', path: '/n2', server: NAS_KEY })

    // 저장 안 된 두 연결이 맨 위에 둘 다
    const rows = serverRows()
    expect(rows[0]).toMatch(/^x@x\.example/)
    expect(rows[1]).toMatch(/^w@w\.example/)
    expect(rows[2]).toMatch(/^Office/)

    // A 행의 해제 버튼은 A만 끊는다
    expect(
      within(nav()).queryByRole('button', { name: 'Disconnect arc@archive.lan:21' })
    ).toBeNull()
    fireEvent.click(
      within(nav()).getByRole('button', { name: 'Disconnect kim@ftp.office.lan:2121' })
    )
    await flush()
    expect(invokeCalls(h.invoke, 'ftp:disconnect')).toEqual([[OFFICE_KEY]])
    expect(invokeCalls(h.invoke, 'ftp:connect')).toEqual([])
  })

  it('lists unsaved connections that are live or broken, not ones that ended', async () => {
    // covers: Test-1034
    setConnection('x@x.example:21', 'connected')
    setConnection('y@y.example:21', 'error')
    setConnection('z@z.example:21', 'disconnected')
    useTabsStore.getState().openTab(localLoc(HOME))
    render(<Sidebar />)
    await flush()
    const rows = serverRows()
    expect(rows[0]).toMatch(/^x@x\.example/)
    expect(rows[1]).toMatch(/^y@y\.example/)
    expect(rows[2]).toMatch(/^Office/)
    expect(serverRows().some((r) => r.startsWith('z@z.example'))).toBe(false)

    act(() => setConnection('z@z.example:21', 'connecting'))
    expect(serverRows().some((r) => r.startsWith('z@z.example'))).toBe(true)
  })

  it('names a saved and an unsaved user on one host apart in the row, its title and its disconnect button', async () => {
    // covers: Test-1144
    const RA = 'ra@127.0.0.1:2121'
    const RB2 = 'rb2@127.0.0.1:2121'
    const LAB: FtpServer = {
      id: 7,
      name: '',
      host: '127.0.0.1',
      port: 2121,
      username: 'ra',
      hasPassword: true,
      secure: false
    }
    useServerStore.setState({ servers: [LAB] })
    setConnection(RA, 'connected')
    setConnection(RB2, 'connected')
    useTabsStore.getState().openTab(localLoc(HOME))
    render(<Sidebar />)
    await flush()

    /** 상태 점이 있는 행 버튼마다 [이름, 둘째 줄, title] */
    const rows = (): string[][] =>
      within(nav())
        .getAllByRole('button')
        .filter((b) => b.querySelector('[data-status]'))
        .map((b) => [
          ...Array.from(b.querySelectorAll('.block')).map((el) => el.textContent ?? ''),
          b.getAttribute('title') ?? ''
        ])
    expect(rows()).toEqual([
      ['rb2@127.0.0.1', RB2, RB2],
      ['127.0.0.1', RA, RA]
    ])

    expect(within(nav()).getByRole('button', { name: `Disconnect ${RA}` })).toBeTruthy()
    fireEvent.click(within(nav()).getByRole('button', { name: `Disconnect ${RB2}` }))
    await flush()
    expect(invokeCalls(h.invoke, 'ftp:disconnect')).toEqual([[RB2]])

    act(() => setConnection('anonymous@h.lan:21', 'connected'))
    expect(rows()[0][0]).toBe('h.lan')
  })

  it("lists under each server row only that account's recent folders", async () => {
    // covers: Test-1151
    const RA = 'ra@127.0.0.1:2121'
    const RB2 = 'rb2@127.0.0.1:2121'
    const LAB: FtpServer = {
      id: 7,
      name: '',
      host: '127.0.0.1',
      port: 2121,
      username: 'ra',
      hasPassword: true,
      secure: false
    }
    useServerStore.setState({ servers: [LAB] })
    setConnection(RA, 'connected')
    setConnection(RB2, 'connected')
    const recent: Record<string, string[]> = { [RA]: ['/photos'], [RB2]: ['/inbox'] }
    h.handlers['ftp:getRecentPaths'] = (key) => ({
      success: true,
      data: (recent[key as string] ?? []).map((path) => ({ path, lastVisited: '' }))
    })
    useTabsStore.getState().openTab(localLoc(HOME))
    render(<Sidebar />)
    await flush()

    expect(invokeCalls(h.invoke, 'ftp:getRecentPaths')).toEqual(
      expect.arrayContaining([[RA], [RB2]])
    )
    expect(invokeCalls(h.invoke, 'ftp:getRecentPaths')).toHaveLength(2)
    // 서버 행과 그 아래 들여쓴 최근 폴더의 순서: 저장 안 된 RB2 행이 위
    const order = within(nav())
      .getAllByRole('button')
      .map((b) =>
        b.querySelector('[data-status]') ? `row ${b.getAttribute('title')}` : (b.textContent ?? '')
      )
      .filter((name) => name.startsWith('row ') || name === 'photos' || name === 'inbox')
    expect(order).toEqual([`row ${RB2}`, 'inbox', `row ${RA}`, 'photos'])

    fireEvent.click(place('inbox'))
    expect(activeTab().loc).toEqual({ side: 'remote', path: '/inbox', server: RB2 })
  })
})
