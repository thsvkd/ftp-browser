/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { en } from '@renderer/i18n/locales/en'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { emptyDraft } from '@renderer/lib/serverAddress'
import { invokeCalls } from '@renderer/test/rendererTestUtils'
import {
  activeTab,
  flush,
  localLoc,
  setConnection,
  setupExplorer,
  type ExplorerHarness
} from '@renderer/components/explorer/explorerTestHarness'
import type { FtpServer } from '@shared/types/ftp'
import { act } from '@testing-library/react'
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
    setConnection('kim@ftp.office.lan:2121', 'connected')
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

  it('connects a saved server with a saved password, or selects it and focuses the password field', async () => {
    // covers: Test-821
    useTabsStore.getState().openTab(localLoc(HOME))
    render(
      <>
        <input type="password" aria-label="toolbar password" />
        <Sidebar />
      </>
    )
    await flush()
    expect(place(/^NAS/).textContent).toContain(en['sidebar.serverOffline'])

    fireEvent.click(place(/^NAS/))
    expect(useServerStore.getState().draft.id).toBe(NAS.id)
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('toolbar password'))
    )
    expect(invokeCalls(h.invoke, 'ftp:connect')).toEqual([])

    fireEvent.click(place(/^Office/))
    await waitFor(() => expect(invokeCalls(h.invoke, 'ftp:connect')).toHaveLength(1))
    expect(invokeCalls(h.invoke, 'ftp:connect')[0][0]).toMatchObject({
      host: OFFICE.host,
      port: OFFICE.port,
      user: 'kim'
    })
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
      [OFFICE.host]: ['/o1', '/o2', '/o3', '/o4', '/o5'],
      [NAS.host]: ['/n1', '/n2', '/n3', '/n4', '/n5']
    }
    h.handlers['ftp:getRecentPaths'] = (host) => ({
      success: true,
      data: (recent[host as string] ?? []).map((path) => ({ path, lastVisited: '' }))
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
      expect.arrayContaining([
        [OFFICE.host, OFFICE.port],
        [NAS.host, NAS.port]
      ])
    )
    for (const name of ['o1', 'o2', 'o3', 'o4', 'n1', 'n2', 'n3', 'n4'])
      expect(place(name)).toBeTruthy()
    for (const name of ['o5', 'n5'])
      expect(within(nav()).queryByRole('button', { name })).toBeNull()
    fireEvent.click(place('n2'))
    expect(activeTab().loc).toEqual({ side: 'remote', path: '/n2', server: NAS_KEY })

    // 저장 안 된 두 연결이 맨 위에 둘 다
    const rows = serverRows()
    expect(rows[0]).toMatch(/^x\.example/)
    expect(rows[1]).toMatch(/^w\.example/)
    expect(rows[2]).toMatch(/^Office/)

    // A 행의 해제 버튼은 A만 끊는다
    expect(within(nav()).queryByRole('button', { name: 'Disconnect Archive' })).toBeNull()
    fireEvent.click(within(nav()).getByRole('button', { name: 'Disconnect Office' }))
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
    expect(rows[0]).toMatch(/^x\.example/)
    expect(rows[1]).toMatch(/^y\.example/)
    expect(rows[2]).toMatch(/^Office/)
    expect(serverRows().some((r) => r.startsWith('z.example'))).toBe(false)

    act(() => setConnection('z@z.example:21', 'connecting'))
    expect(serverRows().some((r) => r.startsWith('z.example'))).toBe(true)
  })
})
