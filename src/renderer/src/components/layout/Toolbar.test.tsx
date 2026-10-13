/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useLayoutStore } from '@renderer/stores/useLayoutStore'
import {
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
