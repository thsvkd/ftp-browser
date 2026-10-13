/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useLayoutStore } from '@renderer/stores/useLayoutStore'
import {
  setupExplorer,
  type ExplorerHarness
} from '@renderer/components/explorer/explorerTestHarness'
import { SidePane } from './SidePane'

const KEY = 'ftp-browser-layout'
const LEFT = 'sidebar-pane'
const RIGHT = 'rail-pane'

let h: ExplorerHarness
beforeEach(() => {
  h = setupExplorer({})
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture
  useLayoutStore.setState({
    left: { width: 220, collapsed: false },
    right: { width: 288, collapsed: false },
    priority: null
  })
  localStorage.clear()
  h.restore()
})

const setLayout = (
  left: { width: number; collapsed: boolean },
  right = { width: 288, collapsed: false },
  priority: 'left' | 'right' | null = null
): void => {
  act(() => useLayoutStore.setState({ left, right, priority }))
}
const panel = (id: string): HTMLElement => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`no #${id}`)
  return el
}
const leftHandle = (): HTMLElement => screen.getByRole('separator', { name: 'Resize sidebar' })
const rightHandle = (): HTMLElement => screen.getByRole('separator', { name: 'Resize side panel' })
const down = (el: HTMLElement, clientX: number, button = 0): boolean =>
  fireEvent.pointerDown(el, { clientX, button, pointerId: 1 })
const move = (el: HTMLElement, clientX: number): boolean =>
  fireEvent.pointerMove(el, { clientX, pointerId: 1 })
const up = (el: HTMLElement, clientX = 0): boolean =>
  fireEvent.pointerUp(el, { clientX, pointerId: 1 })
const stored = (): ReturnType<typeof useLayoutStore.getState> => useLayoutStore.getState()

const Left = ({ width = null }: { width?: number | null }): React.JSX.Element => (
  <SidePane side="left" id={LEFT} containerWidth={width}>
    <button>content</button>
  </SidePane>
)
const Right = ({ width = null }: { width?: number | null }): React.JSX.Element => (
  <SidePane side="right" id={RIGHT} containerWidth={width}>
    <button>content</button>
  </SidePane>
)
const Pair = ({ width }: { width: number | null }): React.JSX.Element => (
  <>
    <SidePane side="left" id={LEFT} containerWidth={width}>
      <button>left content</button>
    </SidePane>
    <SidePane side="right" id={RIGHT} containerWidth={width}>
      <button>right content</button>
    </SidePane>
  </>
)

describe('SidePane — structure and ARIA', () => {
  it('renders the default width, a labelled separator and no inert while expanded', () => {
    // covers: Test-903
    const { unmount } = render(<Left />)
    const p = panel(LEFT)
    expect(p.classList.contains('side-pane')).toBe(true)
    expect(p.style.width).toBe('220px')
    expect((p.firstElementChild as HTMLElement).style.width).toBe('220px')
    const sep = leftHandle()
    expect(sep.getAttribute('aria-orientation')).toBe('vertical')
    expect(sep.tabIndex).toBe(0)
    expect(sep.getAttribute('aria-valuemin')).toBe('0')
    expect(sep.getAttribute('aria-valuemax')).toBe('360')
    expect(sep.getAttribute('aria-valuenow')).toBe('220')
    expect(sep.getAttribute('aria-valuetext')).toBe('220 px')
    expect(sep.getAttribute('aria-controls')).toBe(LEFT)
    expect(p.hasAttribute('inert')).toBe(false)
    expect(p.hasAttribute('aria-hidden')).toBe(false)
    unmount()

    render(<Right />)
    expect(panel(RIGHT).style.width).toBe('288px')
    expect(rightHandle().getAttribute('aria-valuemax')).toBe('480')
    expect(rightHandle().getAttribute('aria-controls')).toBe(RIGHT)
  })
})

describe('SidePane — dragging', () => {
  it('follows the pointer, commits once on release and mirrors the direction on the right', () => {
    // covers: Test-904
    render(<Left />)
    const handle = leftHandle()
    const prevented = !down(handle, 220)
    expect(prevented).toBe(true)
    expect(document.activeElement).toBe(handle)
    move(handle, 300)
    expect(panel(LEFT).style.width).toBe('300px')
    expect(panel(LEFT).getAttribute('data-dragging')).toBe('true')
    expect(stored().left.width).toBe(220)
    expect(localStorage.getItem(KEY) ?? '').not.toContain('300')
    up(handle)
    expect(stored().left).toEqual({ width: 300, collapsed: false })
    expect(panel(LEFT).hasAttribute('data-dragging')).toBe(false)
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}').state.left.width).toBe(300)
    cleanup()

    render(<Right />)
    down(rightHandle(), 700)
    move(rightHandle(), 640)
    expect(panel(RIGHT).style.width).toBe('348px')
  })

  it('collapses mid-drag with hysteresis and remembers the width the drag started with', () => {
    // covers: Test-905
    render(<Left />)
    const handle = leftHandle()
    const p = panel(LEFT)
    const quiet = (): void => expect(p.hasAttribute('data-animate')).toBe(false)
    down(handle, 220)
    move(handle, 90)
    expect(p.style.width).toBe('0px')
    expect(p.hasAttribute('data-collapsed')).toBe(true)
    quiet()
    move(handle, 179)
    expect(p.style.width).toBe('0px')
    move(handle, 180)
    expect(p.style.width).toBe('180px')
    expect(p.hasAttribute('data-collapsed')).toBe(false)
    move(handle, 300)
    expect(p.style.width).toBe('300px')
    move(handle, 90)
    expect(p.style.width).toBe('0px')
    up(handle)
    expect(stored().left).toEqual({ width: 220, collapsed: true })
    quiet()
  })

  it('cancels with Escape, ignores the secondary button and treats cancel and lost capture as release', () => {
    // covers: Test-906
    const capture = vi.fn()
    HTMLElement.prototype.setPointerCapture = capture
    render(<Left />)
    const handle = leftHandle()
    const p = panel(LEFT)

    down(handle, 220)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith(1)
    move(handle, 300)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(p.style.width).toBe('220px')
    up(handle)
    expect(stored().left).toEqual({ width: 220, collapsed: false })
    move(handle, 320)
    expect(p.style.width).toBe('220px')

    down(handle, 220, 2)
    expect(p.hasAttribute('data-dragging')).toBe(false)
    move(handle, 300)
    expect(p.style.width).toBe('220px')

    down(handle, 220)
    move(handle, 280)
    fireEvent.pointerCancel(handle, { pointerId: 1 })
    expect(stored().left).toEqual({ width: 280, collapsed: false })

    down(handle, 280)
    move(handle, 300)
    fireEvent.lostPointerCapture(handle, { pointerId: 1 })
    expect(stored().left).toEqual({ width: 300, collapsed: false })

    down(handle, 300)
    move(handle, 320)
    up(handle)
    act(() => useLayoutStore.setState({ left: { width: 250, collapsed: false } }))
    fireEvent.lostPointerCapture(handle, { pointerId: 1 })
    expect(stored().left).toEqual({ width: 250, collapsed: false })

    down(handle, 250)
    move(handle, 270)
    move(handle, 290)
    expect(p.getAttribute('data-dragging')).toBe('true')
    expect(p.style.width).toBe('290px')
    expect(stored().left.width).toBe(250)
    up(handle)
    expect(stored().left.width).toBe(290)
  })

  it('resets to the default width on double click, expanding a collapsed pane', () => {
    // covers: Test-907
    setLayout({ width: 300, collapsed: false })
    render(<Left />)
    fireEvent.doubleClick(leftHandle())
    expect(stored().left).toEqual({ width: 220, collapsed: false })
    cleanup()

    setLayout({ width: 300, collapsed: true })
    render(<Left />)
    fireEvent.doubleClick(leftHandle())
    expect(stored().left).toEqual({ width: 220, collapsed: false })
    cleanup()

    setLayout({ width: 300, collapsed: false }, { width: 400, collapsed: false })
    render(<Right />)
    fireEvent.doubleClick(rightHandle())
    expect(stored().right).toEqual({ width: 288, collapsed: false })
  })

  it('works from the collapsed edge: starts at 0 and expands once the pointer reaches min', () => {
    // covers: Test-909
    setLayout({ width: 250, collapsed: true })
    render(<Left />)
    const p = panel(LEFT)
    const handle = leftHandle()
    expect(p.style.width).toBe('0px')
    expect(p.hasAttribute('inert')).toBe(true)
    expect(p.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByText('content')).toBeTruthy()
    expect(handle.hasAttribute('data-collapsed')).toBe(true)
    expect(handle.getAttribute('role')).toBe('separator')
    expect(handle.tabIndex).toBe(0)
    expect(handle.getAttribute('aria-valuenow')).toBe('0')
    expect(p.hasAttribute('data-animate')).toBe(false)

    down(handle, 0)
    move(handle, 179)
    expect(p.style.width).toBe('0px')
    move(handle, 200)
    expect(p.style.width).toBe('200px')
    up(handle)
    expect(stored().left).toEqual({ width: 200, collapsed: false })
  })
})

describe('SidePane — keyboard', () => {
  it('resizes with arrows, jumps with Home/End, toggles with Enter and keeps handled keys local', () => {
    // covers: Test-908
    const global = vi.fn()
    window.addEventListener('keydown', global)
    try {
      render(<Left />)
      const handle = leftHandle()
      handle.focus()
      const key = (k: string, shiftKey = false): boolean =>
        fireEvent.keyDown(handle, { key: k, shiftKey })
      expect(key('ArrowRight')).toBe(false)
      expect(stored().left.width).toBe(236)
      expect(handle.getAttribute('aria-valuenow')).toBe('236')
      key('ArrowRight', true)
      expect(stored().left.width).toBe(300)
      key('ArrowLeft')
      expect(stored().left.width).toBe(284)
      key('Home')
      expect(stored().left.width).toBe(180)
      key('ArrowLeft')
      expect(stored().left).toEqual({ width: 180, collapsed: false })
      key('End')
      expect(stored().left.width).toBe(360)
      key('Enter')
      expect(stored().left.collapsed).toBe(true)
      expect(handle.getAttribute('aria-valuenow')).toBe('0')
      expect(handle.getAttribute('aria-valuetext')).toBe('Collapsed')
      key('Enter')
      expect(stored().left).toEqual({ width: 360, collapsed: false })
      expect(global).not.toHaveBeenCalled()
      expect(key('a')).toBe(true)
      expect(global).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', global)
    }
  })

  it('keeps the remembered width when Enter collapses a pane rendered narrower than stored', () => {
    // covers: Test-908
    setLayout({ width: 360, collapsed: false }, { width: 480, collapsed: false })
    render(<Pair width={1024} />)
    const rendered = panel(LEFT).style.width
    expect(rendered).not.toBe('360px')
    leftHandle().focus()
    fireEvent.keyDown(leftHandle(), { key: 'Enter' })
    expect(stored().left).toEqual({ width: 360, collapsed: true })
  })

  it('grows the right pane with ArrowLeft', () => {
    // covers: Test-908
    render(<Right />)
    fireEvent.keyDown(rightHandle(), { key: 'ArrowLeft' })
    expect(stored().right.width).toBe(304)
    fireEvent.keyDown(rightHandle(), { key: 'ArrowRight' })
    expect(stored().right.width).toBe(288)
  })
})

describe('SidePane — animation flag', () => {
  it('turns on data-animate for collapse changes only and clears it on width transitionend or after a timer', () => {
    // covers: Test-910
    vi.useFakeTimers()
    render(<Left />)
    const p = panel(LEFT)
    expect(p.hasAttribute('data-animate')).toBe(false)
    act(() => stored().toggle('left'))
    expect(p.getAttribute('data-animate')).toBe('true')
    fireEvent.transitionEnd(p, { propertyName: 'opacity' })
    expect(p.getAttribute('data-animate')).toBe('true')
    fireEvent.transitionEnd(p, { propertyName: 'width' })
    expect(p.hasAttribute('data-animate')).toBe(false)

    act(() => stored().toggle('left'))
    expect(p.getAttribute('data-animate')).toBe('true')
    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(p.hasAttribute('data-animate')).toBe(false)

    // 접힘이 바뀌지 않는 조작은 켜지 않는다.
    const handle = leftHandle()
    for (const k of ['ArrowRight', 'Home', 'End']) {
      fireEvent.keyDown(handle, { key: k })
      expect(p.hasAttribute('data-animate')).toBe(false)
    }
    down(handle, 360)
    move(handle, 300)
    up(handle)
    expect(stored().left.width).toBe(300)
    expect(p.hasAttribute('data-animate')).toBe(false)
  })

  it('animates handle actions that change the collapsed state, but not a width-only reset', () => {
    // covers: Test-910
    const cases: Array<[string, boolean, (handle: HTMLElement) => void]> = [
      ['Enter', true, (hd) => fireEvent.keyDown(hd, { key: 'Enter' })],
      ['ArrowRight', true, (hd) => fireEvent.keyDown(hd, { key: 'ArrowRight' })],
      ['doubleClick', true, (hd) => fireEvent.doubleClick(hd)]
    ]
    for (const [name, collapsed, action] of cases) {
      setLayout({ width: 300, collapsed })
      const { unmount } = render(<Left />)
      expect(panel(LEFT).hasAttribute('data-animate'), name).toBe(false)
      action(leftHandle())
      expect(panel(LEFT).getAttribute('data-animate'), name).toBe('true')
      unmount()
    }
    setLayout({ width: 300, collapsed: false })
    render(<Left />)
    fireEvent.doubleClick(leftHandle())
    expect(stored().left).toEqual({ width: 220, collapsed: false })
    expect(panel(LEFT).hasAttribute('data-animate')).toBe(false)
  })
})

describe('SidePane — narrow window fit', () => {
  const widths = (): [string, string] => [panel(LEFT).style.width, panel(RIGHT).style.width]
  const maxed = { width: 360, collapsed: false }
  const maxedRight = { width: 480, collapsed: false }

  it('fits for display only, and keeps the pane being dragged at the cap without jumping on release', () => {
    // covers: Test-911
    setLayout(maxed, maxedRight)
    const { rerender } = render(<Pair width={1024} />)
    expect(widths()).toEqual(['233px', '311px'])
    expect(stored().left.width).toBe(360)
    expect(stored().right.width).toBe(480)
    rerender(<Pair width={1400} />)
    expect(widths()).toEqual(['360px', '480px'])
    rerender(<Pair width={1024} />)

    // (가) 상한에서 끌기
    const handle = leftHandle()
    down(handle, 233)
    expect(widths()).toEqual(['233px', '311px'])
    move(handle, 999)
    expect(widths()).toEqual(['233px', '311px'])
    up(handle)
    expect(stored().left).toEqual({ width: 233, collapsed: false })
    expect(stored().priority).toBe('left')
    expect(stored().right.width).toBe(480)
    expect(widths()).toEqual(['233px', '311px'])

    // (나) 더 작게 놓기
    down(handle, 233)
    move(handle, 193)
    expect(widths()).toEqual(['193px', '311px'])
    up(handle)
    expect(widths()).toEqual(['193px', '351px'])
    cleanup()

    // (다) 이동 없이 눌렀다 놓기
    setLayout(maxed, maxedRight)
    render(<Pair width={1024} />)
    down(leftHandle(), 233)
    up(leftHandle(), 233)
    expect(stored().left.width).toBe(360)
    expect(stored().priority).toBeNull()
  })

  it('follows the window size without animating or touching the stored widths', () => {
    // covers: Test-917
    setLayout(maxed, maxedRight)
    const { rerender } = render(<Pair width={1400} />)
    const seen: Array<[string, string]> = [widths()]
    for (const w of [1024, 1400]) {
      rerender(<Pair width={w} />)
      seen.push(widths())
      expect(panel(LEFT).hasAttribute('data-animate')).toBe(false)
      expect(panel(RIGHT).hasAttribute('data-animate')).toBe(false)
    }
    expect(seen).toEqual([
      ['360px', '480px'],
      ['233px', '311px'],
      ['360px', '480px']
    ])
    expect(stored().left.width).toBe(360)
    expect(stored().right.width).toBe(480)
  })
})
