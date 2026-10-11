/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { en } from '@renderer/i18n/locales/en'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { emptyDraft } from '@renderer/lib/serverAddress'
import { invokeCalls } from '@renderer/test/rendererTestUtils'
import {
  activeTab,
  flush,
  localLoc,
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
