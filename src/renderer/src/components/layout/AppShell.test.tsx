/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { en } from '@renderer/i18n/locales/en'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { useLayoutStore } from '@renderer/stores/useLayoutStore'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { emptyDraft } from '@renderer/lib/serverAddress'
import {
  activeTab,
  flush,
  ftp,
  local,
  localLoc,
  option,
  paneEl,
  remoteLoc,
  server,
  setConnection,
  setupExplorer,
  type ExplorerHarness
} from '@renderer/components/explorer/explorerTestHarness'
import { fromLocalEntry, type Loc } from '@renderer/lib/explorerEntry'
import { invokeCalls } from '@renderer/test/rendererTestUtils'
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

describe('AppShell — connection status', () => {
  it('subscribes to ftp:connectionStatus once for the app, with or without tabs', async () => {
    // covers: Test-1033
    const B = 'bob@b.example.com:2121'
    const A = 'alice@a.example.com:21'
    h.handlers['local:getHome'] = () => ({ success: false, error: 'no home' })
    const handlers: Array<(...args: unknown[]) => void> = []
    const unsubscribe = vi.fn()
    h.api.on.mockImplementation((channel: string, handler: (...args: unknown[]) => void) => {
      if (channel !== 'ftp:connectionStatus') return () => undefined
      handlers.push(handler)
      return unsubscribe
    })
    const view = render(<AppShell />)
    await flush()
    expect(useTabsStore.getState().tabs).toHaveLength(0)
    expect(handlers).toHaveLength(1)

    act(() =>
      handlers[0]({
        server: B,
        status: 'connected',
        host: 'b.example.com',
        port: 2121,
        user: 'bob'
      })
    )
    expect(useFtpStore.getState().connections[B].status).toBe('connected')

    act(() => {
      useTabsStore.getState().openTab({ side: 'remote', path: '/', server: A })
      useTabsStore.getState().openTab({ side: 'remote', path: '/', server: B })
    })
    await flush()
    act(() => useTabsStore.getState().cycleTab(1))
    await flush()
    expect(handlers).toHaveLength(1)

    view.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

describe('AppShell — regions', () => {
  it('cycles focus sidebar → tabs → list → the shelf dock with F6 and back with Shift+F6', async () => {
    // covers: Test-834
    render(<AppShell />)
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    // 선반이 도크로 옮긴 뒤(함정 E): 담긴 항목의 행이 F6의 네 번째 지역이다.
    // 담아도 펼쳐지지 않으므로(shelf-island I8) 행에 닿으려면 펼친다
    act(() => {
      useShelfStore.getState().add([fromLocalEntry(local(HOME, 's.txt'))])
      useShelfStore.getState().setDockOpen(true)
    })
    const key = (shiftKey = false): void => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F6', shiftKey })
    }
    const sidebarCurrent = within(
      screen.getByRole('navigation', { name: en['sidebar.label'] })
    ).getByRole('button', { name: 'Downloads' })
    expect(sidebarCurrent.getAttribute('aria-current')).toBe('location')
    const dockRow = screen.getByRole('listitem', { name: /^s\.txt,/ })

    // 처음에는 다른 것이 포커스를 갖고 있지 않으니 목록이 받는다(함정 13).
    expect(document.activeElement).toBe(screen.getByRole('listbox'))
    key()
    expect(document.activeElement).toBe(dockRow)
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
    expect(document.activeElement).toBe(dockRow)
  })

  it('reaches the collapsed shelf pill with F6', async () => {
    // covers: Test-1290
    render(<AppShell />)
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    act(() => {
      useShelfStore.getState().add([fromLocalEntry(local(HOME, 's.txt'))])
      useShelfStore.getState().setDockOpen(false)
    })
    expect(document.activeElement).toBe(screen.getByRole('listbox'))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F6' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /1 item/ }))
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

    // 사이드바를 접으면 탭과 목록만 돈다(선반은 도크로 옮겨 빈 선반이면 F6 지역이 없다).
    list.focus()
    f6()
    expect(document.activeElement).toBe(tab)
    f6()
    expect(document.activeElement).toBe(list)
    f6()
    expect(document.activeElement).toBe(tab)
    f6(true)
    expect(document.activeElement).toBe(list)
    f6(true)
    expect(document.activeElement).toBe(tab)

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
      screen.getByRole('region', { name: en['rail.info'] }).closest('#rail-pane')
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

describe('AppShell — split view', () => {
  it('returns focus from the conflict sheet to the active right pane list when its opener is gone', async () => {
    // covers: Test-1085
    render(<AppShell />)
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    const L = activeTab().id
    const R = useTabsStore.getState().openTab({ side: 'local', path: HOME }, false)
    act(() => useTabsStore.setState({ split: { leftId: L, rightId: R, ratio: 0.5 }, activeId: R }))
    await flush()
    expect(screen.getAllByRole('listbox')).toHaveLength(2)

    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    act(() => {
      void useTransferStore.getState().askConflicts('copy', [
        {
          target: `${HOME}\\a.txt`,
          source: 'C:\\in\\a.txt',
          name: 'a.txt',
          incoming: { size: 2048, modifiedAt: '2024-05-02T10:00:00.000Z' },
          existing: { size: 1024, modifiedAt: '2024-05-01T10:00:00.000Z' }
        }
      ])
    })
    await screen.findByRole('alertdialog')
    opener.remove()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(document.activeElement).toBe(document.getElementById(`explorer-list-${R}`))
    expect(useTabsStore.getState().activeId).toBe(R)
  })
})

/** 탭 두 개의 짝을 만들고 AppShell을 그린다. 기본은 왼쪽이 활성. */
async function startSplit(
  rightLoc: Loc = localLoc(HOME),
  active: 'left' | 'right' = 'left'
): Promise<{ L: string; R: string }> {
  render(<AppShell />)
  await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
  const L = activeTab().id
  const R = useTabsStore.getState().openTab(rightLoc, false)
  act(() =>
    useTabsStore.setState({
      split: { leftId: L, rightId: R, ratio: 0.5 },
      activeId: active === 'right' ? R : L
    })
  )
  await flush()
  return { L, R }
}

const backslash = (init: Partial<KeyboardEventInit>): Partial<KeyboardEventInit> => ({
  key: '\\',
  code: 'Backslash',
  ...init
})

describe('AppShell — split view shortcuts', () => {
  it('toggles the split view with Ctrl+backslash or Cmd+backslash on any layout, but not from a text field or with one tab', async () => {
    // covers: Test-1081
    render(<AppShell />)
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    const split = (): unknown => useTabsStore.getState().split

    // 탭이 하나면 아무 일 없다
    fireEvent.keyDown(screen.getByRole('listbox'), backslash({ ctrlKey: true }))
    expect(split()).toBeNull()

    act(() => {
      useTabsStore.getState().openTab(localLoc(HOME))
    })
    await flush()
    const active = useTabsStore.getState().activeId
    expect(fireEvent.keyDown(screen.getAllByRole('listbox')[0], backslash({ ctrlKey: true }))).toBe(
      false
    )
    expect(split()).not.toBeNull()
    expect(useTabsStore.getState().activeId).toBe(active)
    expect(screen.getAllByRole('listbox')).toHaveLength(2)

    fireEvent.keyDown(document.body, backslash({ ctrlKey: true }))
    expect(split()).toBeNull()
    expect(screen.getAllByRole('listbox')).toHaveLength(1)

    // macOS 한국어 자판: Cmd + ₩ (code는 Backslash)
    fireEvent.keyDown(document.body, backslash({ key: '₩', metaKey: true }))
    expect(split()).not.toBeNull()
    fireEvent.keyDown(document.body, backslash({ key: '₩', metaKey: true }))
    expect(split()).toBeNull()

    // 경로 입력 칸에서는 무시한다
    fireEvent.keyDown(screen.getAllByRole('listbox')[0], { key: 'l', ctrlKey: true })
    const path = screen.getByRole('textbox', { name: en['path.edit'] })
    fireEvent.keyDown(path, backslash({ ctrlKey: true }))
    expect(split()).toBeNull()
  })

  it('cycles F6 sidebar, tabs, left list, right list and activates the right pane on reaching it', async () => {
    // covers: Test-1082
    const { L, R } = await startSplit()
    const f6 = (shiftKey = false): void => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F6', shiftKey })
    }
    const sidebarCurrent = within(
      screen.getByRole('navigation', { name: en['sidebar.label'] })
    ).getByRole('button', { name: 'Downloads' })
    const activeTabButton = (): Element | null =>
      document.querySelector('[data-region="tabs"] [role="tab"][aria-selected="true"]')
    const listOf = (id: string): HTMLElement => document.getElementById(`explorer-list-${id}`)!
    expect(document.activeElement).toBe(listOf(L))

    f6() // 왼쪽 목록 → (다음) 오른쪽 목록
    expect(document.activeElement).toBe(listOf(R))
    expect(useTabsStore.getState().activeId).toBe(R)
    f6() // 선반은 도크로 옮겼다(함정 E): 레일은 지역이 없다
    expect(document.activeElement).toBe(sidebarCurrent)
    f6()
    expect(document.activeElement).toBe(activeTabButton())
    expect(useTabsStore.getState().activeId).toBe(R)
    f6()
    expect(document.activeElement).toBe(listOf(L))
    expect(useTabsStore.getState().activeId).toBe(L)
    f6()
    expect(document.activeElement).toBe(listOf(R))

    // 반대 방향
    f6(true)
    expect(document.activeElement).toBe(listOf(L))
    expect(useTabsStore.getState().activeId).toBe(L)
    f6(true)
    expect(document.activeElement).toBe(activeTabButton())
    f6(true)
    expect(document.activeElement).toBe(sidebarCurrent)
    f6(true)
    expect(document.activeElement).toBe(listOf(R))
    expect(useTabsStore.getState().activeId).toBe(R)
  })

  it('runs window shortcuts on the active pane tab: reload, send the shelf, edit the path', async () => {
    // covers: Test-1083
    // jsdom에는 Element.animate가 없다. 날아가는 효과(flyTo)가 그것을 부른다.
    ;(HTMLElement.prototype as { animate?: unknown }).animate = vi.fn(() => ({}))
    setConnection(server(), 'connected')
    const LDIR = HOME
    h.handlers['transfer:send'] = () => ({
      success: true,
      data: { batchId: 'b1', ids: ['1'], skipped: [], conflicts: [], totalBytes: 1 }
    })
    const { R } = await startSplit(remoteLoc('/photos'))
    act(() => {
      useShelfStore.getState().add([fromLocalEntry(local(LDIR, 'a.txt'))])
    })
    fireEvent.pointerDown(paneEl('right'))
    expect(useTabsStore.getState().activeId).toBe(R)

    // F5: 오른쪽 경로만 다시 읽는다
    h.invoke.mockClear()
    fireEvent.keyDown(document.body, { key: 'F5' })
    await flush()
    expect(invokeCalls(h.invoke, 'ftp:list')).toEqual([[server(), '/photos']])
    expect(invokeCalls(h.invoke, 'local:list')).toEqual([])

    // Ctrl+Enter: 오른쪽 위치로 보낸다
    fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true })
    await flush()
    const [conn, req] = invokeCalls(h.invoke, 'transfer:send')[0]
    expect(conn).toBe(server())
    expect(req).toMatchObject({
      direction: 'upload',
      sources: [`${LDIR}\\a.txt`],
      destDir: '/photos'
    })

    // Ctrl+L: 오른쪽 경로 막대만 입력 모드
    fireEvent.keyDown(document.body, { key: 'l', ctrlKey: true })
    const boxes = screen.getAllByRole('textbox', { name: en['path.edit'] })
    expect(boxes).toHaveLength(1)
    expect(paneEl('right').contains(boxes[0])).toBe(true)
    delete (HTMLElement.prototype as { animate?: unknown }).animate
  })

  it('follows the active pane in the status bar, sidebar, shelf destination and info panel', async () => {
    // covers: Test-1084
    h.remote['/photos'] = [ftp('x.jpg'), ftp('y.jpg'), ftp('z.jpg')]
    setConnection(server(), 'connected')
    await startSplit(remoteLoc('/photos'))
    act(() => {
      useShelfStore.getState().add([fromLocalEntry(local('C:\\other', 's.txt'))])
    })
    const status = (): HTMLElement => screen.getByRole('contentinfo')
    const sidebar = (): HTMLElement => screen.getByRole('navigation', { name: en['sidebar.label'] })
    const rail = (): HTMLElement => document.querySelector<HTMLElement>('[data-region="info"]')!
    const dock = (): HTMLElement =>
      document.querySelector<HTMLElement>('[data-region="shelf-dock"]')!
    const current = (): Element | null => sidebar().querySelector('[aria-current="location"]')

    const expectLeft = (): void => {
      expect(within(status()).getByText('1 item')).toBeTruthy()
      expect(current()?.textContent).toContain('Downloads')
      expect(within(dock()).getByText(/to Downloads$/)).toBeTruthy()
    }
    const expectRight = (): void => {
      expect(within(status()).getByText('3 items')).toBeTruthy()
      expect(current()?.textContent ?? '').not.toContain('Downloads')
      expect(within(dock()).getByText(/to photos$/)).toBeTruthy()
    }
    expectLeft()
    fireEvent.pointerDown(paneEl('right'))
    expectRight()
    fireEvent.pointerDown(paneEl('left'))
    expectLeft()
    fireEvent.pointerDown(paneEl('right'))
    expectRight()

    // 정보 패널의 폴더 요약 — 레일은 정보 전용이다(F1).
    expect(within(rail()).getByRole('heading', { name: 'photos' })).toBeTruthy()
    fireEvent.pointerDown(paneEl('left'))
    expect(within(rail()).getByRole('heading', { name: 'Downloads' })).toBeTruthy()
  })
})

describe('AppShell — collapsing a side pane in the split view', () => {
  it('moves focus to the active pane list, not the first one, and keeps the active tab', async () => {
    // covers: Test-1128
    const { L, R } = await startSplit(localLoc(HOME), 'right')
    const nav = screen.getByRole('navigation', { name: en['sidebar.label'] })
    within(nav).getByRole('button', { name: 'Downloads' }).focus()
    act(() => useLayoutStore.getState().toggle('left'))
    expect(layout().left.collapsed).toBe(true)
    expect(document.activeElement).toBe(document.getElementById(`explorer-list-${R}`))
    expect(useTabsStore.getState().activeId).toBe(R)

    // 단일 보기에서는 지금처럼 그 탭의 목록
    act(() => useLayoutStore.getState().toggle('left'))
    act(() => useTabsStore.getState().unsplit())
    act(() => useTabsStore.getState().activate(L))
    await flush()
    within(screen.getByRole('navigation', { name: en['sidebar.label'] }))
      .getByRole('button', { name: 'Downloads' })
      .focus()
    act(() => useLayoutStore.getState().toggle('left'))
    expect(document.activeElement).toBe(document.getElementById(`explorer-list-${L}`))
  })
})

describe('AppShell — transfer panel', () => {
  it('mounts the transfer panel outside every focus region', async () => {
    // covers: Test-1115
    render(<AppShell />)
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    expect(screen.queryByRole('region', { name: 'Transfers' })).toBeNull()

    act(() =>
      useTransferStore.setState({
        pendingSends: [{ id: 'send1', label: 'photos' }],
        panel: { open: true, collapsed: false, rows: ['send:send1'] }
      })
    )
    const panel = screen.getByRole('region', { name: 'Transfers' })
    expect(panel.closest('[data-region]')).toBeNull()
  })
})
