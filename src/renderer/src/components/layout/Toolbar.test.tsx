/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLayoutStore } from '@renderer/stores/useLayoutStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { emptyDraft } from '@renderer/lib/serverAddress'
import { invokeCalls } from '@renderer/test/rendererTestUtils'
import {
  localLoc,
  remoteLoc,
  setConnection,
  setupExplorer,
  type ExplorerHarness
} from '@renderer/components/explorer/explorerTestHarness'
import { Toolbar } from './Toolbar'

let h: ExplorerHarness
beforeEach(() => {
  h = setupExplorer({ connected: false })
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

const ends = (root: HTMLElement): { first: HTMLElement; last: HTMLElement } => ({
  first: root.firstElementChild as HTMLElement,
  last: root.lastElementChild as HTMLElement
})

describe('Toolbar — pane toggles', () => {
  it('puts the toggles at both ends with state, controls and shortcut tooltips, and flips the stores on click', () => {
    // covers: Test-912
    const { container } = render(<Toolbar onSettingsClick={vi.fn()} />)
    const root = container.firstElementChild as HTMLElement
    let { first, last } = ends(root)
    expect(first.getAttribute('aria-label')).toBe('Sidebar')
    expect(last.getAttribute('aria-label')).toBe('Side panel')
    expect(first.getAttribute('aria-expanded')).toBe('true')
    expect(last.getAttribute('aria-expanded')).toBe('true')
    expect(first.getAttribute('aria-controls')).toBe('sidebar-pane')
    expect(last.getAttribute('aria-controls')).toBe('rail-pane')
    expect(first.getAttribute('title')).toBe('Show or hide the sidebar (Ctrl+B)')
    expect(last.getAttribute('title')).toBe('Show or hide the side panel (Ctrl+Alt+B)')

    fireEvent.click(first)
    expect(useLayoutStore.getState().left.collapsed).toBe(true)
    expect(first.getAttribute('aria-expanded')).toBe('false')
    expect(useLayoutStore.getState().right.collapsed).toBe(false)
    fireEvent.click(last)
    expect(useLayoutStore.getState().right.collapsed).toBe(true)
    expect(last.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(first)
    expect(first.getAttribute('aria-expanded')).toBe('true')
    cleanup()

    // 연결 해제 버튼이 나타나도 오른쪽 토글이 마지막이다.
    h.restore()
    h = setupExplorer({ connected: true })
    useTabsStore.getState().openTab(remoteLoc('/'))
    const connected = render(<Toolbar onSettingsClick={vi.fn()} />)
    ;({ first, last } = ends(connected.container.firstElementChild as HTMLElement))
    expect(first.getAttribute('aria-label')).toBe('Sidebar')
    expect(last.getAttribute('aria-label')).toBe('Side panel')
    expect(
      Array.from(connected.container.querySelectorAll('button')).some((b) =>
        /disconnect/i.test(b.textContent ?? '')
      )
    ).toBe(true)
    cleanup()

    h.api.platform = 'darwin'
    const mac = render(<Toolbar onSettingsClick={vi.fn()} />)
    ;({ first, last } = ends(mac.container.firstElementChild as HTMLElement))
    expect(first.getAttribute('title')).toBe('Show or hide the sidebar (⌘B)')
    expect(last.getAttribute('title')).toBe('Show or hide the side panel (⌥⌘B)')
  })
})

describe("Toolbar — the active tab's server", () => {
  const A = 'alice@a.example.com:21'
  const B = 'bob@b.example.com:2121'

  it('shows and disconnects only the server of the active remote tab, and adds a form connect', async () => {
    // covers: Test-1022
    useServerStore.setState({
      servers: [],
      draft: emptyDraft(),
      address: '',
      connecting: false,
      error: ''
    })
    setConnection(A, 'connected')
    setConnection(B, 'connected')
    useTabsStore.getState().openTab({ side: 'remote', path: '/', server: A })
    render(<Toolbar onSettingsClick={vi.fn()} />)

    // A가 연결됨으로 보인다(주소 폼 없음)
    expect(screen.queryByRole('textbox', { name: 'Server address' })).toBeNull()
    expect(screen.getByRole('button', { name: /a\.example\.com/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /b\.example\.com/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(invokeCalls(h.invoke, 'ftp:disconnect')).toEqual([[A]]))

    // 활성 탭이 로컬이면 B가 연결돼 있어도 연결 폼, 해제 버튼 없음
    act(() => {
      setConnection(A, 'connected')
      useTabsStore.getState().openTab(localLoc('C:\\work'))
    })
    expect(screen.getByRole('textbox', { name: 'Server address' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull()

    // 폼으로 C를 연결해도 아무것도 끊지 않는다
    h.invoke.mockClear()
    await userEvent
      .setup()
      .type(screen.getByRole('textbox', { name: 'Server address' }), 'carol@c.example.com{Enter}')
    await waitFor(() => expect(invokeCalls(h.invoke, 'ftp:connect')).toHaveLength(1))
    await waitFor(() => expect(useServerStore.getState().connecting).toBe(false))
    expect(invokeCalls(h.invoke, 'ftp:disconnect')).toEqual([])
  })
})
