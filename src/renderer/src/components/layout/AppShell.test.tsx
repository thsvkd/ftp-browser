/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { en } from '@renderer/i18n/locales/en'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { useLayoutStore } from '@renderer/stores/useLayoutStore'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { emptyDraft } from '@renderer/lib/serverAddress'
import {
  activeTab,
  ftp,
  local,
  option,
  setupExplorer,
  type ExplorerHarness
} from '@renderer/components/explorer/explorerTestHarness'
import { AppShell } from './AppShell'

const HOME = 'C:\\Users\\me\\Downloads'

let h: ExplorerHarness
beforeEach(() => {
  vi.clearAllMocks()
  h = setupExplorer({
    connected: false,
    local: { [HOME]: [local(HOME, 'a.txt')] },
    remote: { '/photos': [ftp('x.jpg')], '/': [ftp('r.txt')] }
  })
  h.handlers['local:getHome'] = () => ({ success: true, data: HOME })
  h.handlers['ftp:getRecentPaths'] = () => ({
    success: true,
    data: [{ path: '/photos', lastVisited: '' }]
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
  cleanup()
  useLayoutStore.setState({
    left: { width: 220, collapsed: false },
    right: { width: 288, collapsed: false },
    priority: null
  })
  localStorage.clear()
  h.restore()
})

const connectFromToolbar = async (): Promise<void> => {
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: 'Server address' }), 'me@nas.local{Enter}')
}

describe('AppShell — start and connect', () => {
  it('starts with one local tab at home and activates a remote tab at the start folder on connect', async () => {
    // covers: Test-825
    render(<AppShell />)
    await waitFor(() => expect(useTabsStore.getState().tabs).toHaveLength(1))
    expect(activeTab().loc).toEqual({ side: 'local', path: HOME })

    await connectFromToolbar()
    await waitFor(() =>
      expect(activeTab().loc).toEqual({
        side: 'remote',
        path: '/photos',
        server: 'me@nas.local:21'
      })
    )
    expect(useTabsStore.getState().tabs.map((t) => t.loc.side)).toEqual(['local', 'remote'])
  })

  it('falls back to the root when the start folder cannot be listed', async () => {
    // covers: Test-825
    delete h.remote['/photos']
    render(<AppShell />)
    await waitFor(() => expect(useTabsStore.getState().tabs).toHaveLength(1))

    await connectFromToolbar()
    await waitFor(() =>
      expect(activeTab().loc).toEqual({ side: 'remote', path: '/', server: 'me@nas.local:21' })
    )
  })
})

describe('AppShell — regions', () => {
  it('cycles focus sidebar → tabs → list → rail with F6 and back with Shift+F6', async () => {
    // covers: Test-834
    render(<AppShell />)
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    const key = (shiftKey = false): void => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F6', shiftKey })
    }
    const sidebarCurrent = within(
      screen.getByRole('navigation', { name: en['sidebar.label'] })
    ).getByRole('button', { name: 'Downloads' })
    expect(sidebarCurrent.getAttribute('aria-current')).toBe('location')
    const shelfTab = screen.getByRole('tab', { name: new RegExp(`^${en['shelf.title']}`) })

    // 처음에는 다른 것이 포커스를 갖고 있지 않으니 목록이 받는다(함정 13).
    expect(document.activeElement).toBe(screen.getByRole('listbox'))
    key()
    expect(document.activeElement).toBe(shelfTab)
    key()
    expect(document.activeElement).toBe(sidebarCurrent)
    key()
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Downloads' }))
    key()
    expect(document.activeElement).toBe(screen.getByRole('listbox'))
    key(true)
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Downloads' }))
    key(true)
    expect(document.activeElement).toBe(sidebarCurrent)
    key(true)
    expect(document.activeElement).toBe(shelfTab)
  })
})

const layout = (): ReturnType<typeof useLayoutStore.getState> => useLayoutStore.getState()
const ctrlB = (target: Element, init: Partial<KeyboardEventInit> = {}): boolean =>
  fireEvent.keyDown(target, { key: 'b', code: 'KeyB', ctrlKey: true, ...init })
const startShell = async (): Promise<void> => {
  render(<AppShell />)
  await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
}

describe('AppShell — pane shortcuts', () => {
  it('toggles the sidebar with Ctrl+B and the rail with Ctrl+Alt+B, also from a text field', async () => {
    // covers: Test-913
    await startShell()
    expect(ctrlB(document.body)).toBe(false)
    expect(layout().left.collapsed).toBe(true)
    expect(layout().right.collapsed).toBe(false)
    ctrlB(document.body)
    expect(layout().left.collapsed).toBe(false)
    ctrlB(document.body, { altKey: true })
    expect(layout().right.collapsed).toBe(true)
    ctrlB(document.body, { altKey: true })
    expect(layout().right.collapsed).toBe(false)

    // 수식키가 맞지 않으면 무반응이다.
    expect(ctrlB(document.body, { shiftKey: true })).toBe(true)
    expect(fireEvent.keyDown(document.body, { key: 'b', code: 'KeyB', metaKey: true })).toBe(true)
    expect(layout().left.collapsed).toBe(false)
    expect(layout().right.collapsed).toBe(false)

    // 주소 입력 칸에 포커스가 있어도 된다.
    const address = screen.getByRole('textbox', { name: 'Server address' })
    address.focus()
    ctrlB(address)
    expect(layout().left.collapsed).toBe(true)
    ctrlB(address, { altKey: true })
    expect(layout().right.collapsed).toBe(true)
  })

  it('uses Cmd+B and Opt+Cmd+B on macOS, matching by code because Opt+B types a different key', async () => {
    // covers: Test-913
    h.api.platform = 'darwin'
    await startShell()
    fireEvent.keyDown(document.body, { key: 'b', code: 'KeyB', metaKey: true })
    expect(layout().left.collapsed).toBe(true)
    fireEvent.keyDown(document.body, { key: '∫', code: 'KeyB', metaKey: true, altKey: true })
    expect(layout().right.collapsed).toBe(true)
    expect(ctrlB(document.body)).toBe(true)
    expect(layout().left.collapsed).toBe(true)
    fireEvent.keyDown(document.body, { key: 'ㅠ', code: 'KeyB', metaKey: true })
    expect(layout().left.collapsed).toBe(false)
  })
})

describe('AppShell — collapsed panes', () => {
  it('moves focus to the list when the focused pane collapses and skips collapsed regions on F6', async () => {
    // covers: Test-914
    await startShell()
    const nav = screen.getByRole('navigation', { name: en['sidebar.label'] })
    const current = within(nav).getByRole('button', { name: 'Downloads' })
    const list = screen.getByRole('listbox')
    const shelfTab = screen.getByRole('tab', { name: new RegExp(`^${en['shelf.title']}`) })
    const tab = screen.getByRole('tab', { name: 'Downloads' })
    const f6 = (shiftKey = false): void => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F6', shiftKey })
    }

    current.focus()
    ctrlB(current)
    expect(document.activeElement).toBe(list)
    ctrlB(current)
    expect(layout().left.collapsed).toBe(false)

    // 포커스가 다른 곳에 있으면 옮기지 않는다.
    tab.focus()
    ctrlB(tab)
    expect(layout().left.collapsed).toBe(true)
    expect(document.activeElement).toBe(tab)

    // 사이드바를 접으면 탭 → 목록 → 레일 → 탭.
    list.focus()
    f6()
    expect(document.activeElement).toBe(shelfTab)
    f6()
    expect(document.activeElement).toBe(tab)
    f6()
    expect(document.activeElement).toBe(list)
    f6(true)
    expect(document.activeElement).toBe(tab)
    f6(true)
    expect(document.activeElement).toBe(shelfTab)

    // 레일만 접으면 사이드바 → 탭 → 목록.
    act(() => layout().toggle('left'))
    act(() => layout().toggle('right'))
    expect(layout().left.collapsed).toBe(false)
    list.focus()
    f6()
    expect(document.activeElement).toBe(current)
    f6()
    expect(document.activeElement).toBe(tab)
    f6()
    expect(document.activeElement).toBe(list)

    // 둘 다 접어도 순환이 멈추지 않는다.
    act(() => layout().toggle('left'))
    list.focus()
    f6()
    expect(document.activeElement).toBe(tab)
    f6()
    expect(document.activeElement).toBe(list)
  })

  it('wraps each pane, hides a collapsed sidebar from the accessibility tree without unmounting it and restores the remembered width', async () => {
    // covers: Test-915
    await startShell()
    const nav = screen.getByRole('navigation', { name: en['sidebar.label'] })
    expect(nav.closest('#sidebar-pane')).not.toBeNull()
    expect(
      screen.getByRole('region', { name: en['shelf.title'] }).closest('#rail-pane')
    ).not.toBeNull()
    expect(screen.getAllByRole('separator')).toHaveLength(2)

    act(() => layout().commit('left', { width: 300 }))
    expect(document.getElementById('sidebar-pane')?.style.width).toBe('300px')
    ctrlB(document.body)
    expect(screen.queryByRole('navigation', { name: en['sidebar.label'] })).toBeNull()
    expect(screen.getByRole('navigation', { name: en['sidebar.label'], hidden: true })).toBeTruthy()
    ctrlB(document.body)
    expect(screen.getByRole('navigation', { name: en['sidebar.label'] })).toBeTruthy()
    expect(document.getElementById('sidebar-pane')?.style.width).toBe('300px')
  })

  it('renders a stored collapsed sidebar collapsed from the first frame without animating', async () => {
    // covers: Test-915
    useLayoutStore.setState({ left: { width: 300, collapsed: true } })
    await startShell()
    const pane = document.getElementById('sidebar-pane') as HTMLElement
    expect(pane.style.width).toBe('0px')
    expect(pane.hasAttribute('data-animate')).toBe(false)
    expect(screen.queryByRole('navigation', { name: en['sidebar.label'] })).toBeNull()
  })

  it('shelves with Shift+S while the rail is collapsed and leaves it collapsed', async () => {
    // covers: Test-916
    // jsdom에는 Element.animate가 없다. 날아가는 효과(flyTo)가 그것을 부른다.
    const animate = vi.fn(() => ({}))
    ;(HTMLElement.prototype as { animate?: unknown }).animate = animate
    try {
      await startShell()
      act(() => layout().toggle('right'))
      expect(layout().right.collapsed).toBe(true)
      fireEvent.click(option('a.txt'))
      fireEvent.keyDown(screen.getByRole('listbox'), { key: 'S', shiftKey: true })
      expect(useShelfStore.getState().items.map((i) => i.entry.name)).toEqual(['a.txt'])
      expect(layout().right.collapsed).toBe(true)
    } finally {
      delete (HTMLElement.prototype as { animate?: unknown }).animate
    }
  })
})
