/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { en } from '@renderer/i18n/locales/en'
import { fromFtpEntry } from '@renderer/lib/explorerEntry'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { useDnd } from '@renderer/components/explorer/dnd'
import { Explorer } from '@renderer/components/explorer/Explorer'
import {
  activeTab,
  flush,
  ftp,
  localLoc,
  option,
  remoteLoc,
  server,
  setupExplorer,
  type ExplorerHarness
} from '@renderer/components/explorer/explorerTestHarness'
import { Sidebar } from './Sidebar'
import { TabStrip } from './TabStrip'

let h: ExplorerHarness
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  h.restore()
})

const tabs = (): HTMLElement[] => screen.getAllByRole('tab')
// 끄는 중에는 동사 배지가 이름에 붙으므로 앞부분으로 찾는다.
const tab = (name: string): HTMLElement => screen.getByRole('tab', { name: new RegExp(`^${name}`) })
const paths = (): string[] => useTabsStore.getState().tabs.map((t) => t.loc.path)
const dt = (): Record<string, unknown> => ({ types: [], files: [], dropEffect: '' })

describe('TabStrip — tabs and keys', () => {
  beforeEach(() => {
    h = setupExplorer()
    useTabsStore.getState().openTab(localLoc('C:\\work'))
    useTabsStore.getState().openTab(remoteLoc('/photos'), false)
    useTabsStore.getState().openTab(localLoc('C:\\music'), false)
  })

  it('shows source badge and name, closes by button, middle click and Delete, and handles Ctrl+T/W/Tab and arrow focus', () => {
    // covers: Test-822
    render(<TabStrip />)
    const list = screen.getByRole('tablist', { name: en['tabs.label'] })
    expect(within(list).getAllByRole('tab')).toHaveLength(3)
    expect(tab('work').querySelector('.lucide-laptop')).toBeTruthy()
    expect(tab('photos').querySelector('.lucide-server')).toBeTruthy()
    expect(tab('work').getAttribute('aria-selected')).toBe('true')

    // ←→·Home/End로 탭 사이 포커스
    tab('work').focus()
    fireEvent.keyDown(tab('work'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tab('photos'))
    fireEvent.keyDown(tab('photos'), { key: 'End' })
    expect(document.activeElement).toBe(tab('music'))
    fireEvent.keyDown(tab('music'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tab('work'))
    fireEvent.keyDown(tab('work'), { key: 'Home' })
    expect(document.activeElement).toBe(tab('work'))
    fireEvent.keyDown(tab('work'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(tab('music'))

    // Ctrl+Tab 순환, Ctrl+T는 지금 위치로 새 탭, Ctrl+W는 활성 탭 닫기
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true })
    expect(activeTab().loc.path).toBe('/photos')
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true })
    expect(activeTab().loc.path).toBe('C:\\work')
    fireEvent.keyDown(window, { key: 't', ctrlKey: true })
    expect(paths()).toEqual(['C:\\work', '/photos', 'C:\\music', 'C:\\work'])
    expect(activeTab().id).toBe(useTabsStore.getState().tabs[3].id)
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true })
    expect(paths()).toEqual(['C:\\work', '/photos', 'C:\\music'])

    // 닫기 버튼, 가운데 클릭, Delete
    fireEvent.click(screen.getByRole('button', { name: 'Close music tab' }))
    expect(paths()).toEqual(['C:\\work', '/photos'])
    fireEvent(tab('photos'), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(paths()).toEqual(['C:\\work'])
    // 마지막 탭은 닫지 않는다(닫기 버튼도 없다).
    fireEvent.keyDown(tab('work'), { key: 'Delete' })
    expect(paths()).toEqual(['C:\\work'])
    expect(screen.queryByRole('button', { name: 'Close work tab' })).toBeNull()
    act(() => void useTabsStore.getState().openTab(localLoc('C:\\b'), false))
    fireEvent.keyDown(tab('b'), { key: 'Delete' })
    expect(paths()).toEqual(['C:\\work'])
    expect(tabs()).toHaveLength(1)
  })
})

describe('TabStrip — spring while dragging', () => {
  it('activates a tab, a sidebar place or a folder tile after 600 ms of hovering, not before', async () => {
    // covers: Test-810
    h = setupExplorer({
      remote: { '/photos': [ftp('sub', { dir: true }), ftp('a.jpg')], '/photos/sub': [] },
      local: { 'C:\\work': [] }
    })
    useTabsStore.getState().openTab(remoteLoc('/photos'))
    useTabsStore.getState().openTab(localLoc('C:\\work'), false)
    render(
      <>
        <TabStrip />
        <Sidebar />
        <Explorer />
      </>
    )
    await flush()
    vi.useFakeTimers()
    const dragged = [fromFtpEntry(ftp('a.jpg'), '/photos', server())]
    act(() => useDnd.setState({ items: dragged, over: null, thumbs: [] }))

    // 탭: 떠나면 바뀌지 않는다.
    fireEvent.dragOver(tab('work'), { dataTransfer: dt() })
    await act(() => vi.advanceTimersByTimeAsync(599))
    act(() => useDnd.setState({ over: null }))
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(activeTab().loc.path).toBe('/photos')

    // 머무르면 600ms에 열린다.
    fireEvent.dragOver(tab('work'), { dataTransfer: dt() })
    await act(() => vi.advanceTimersByTimeAsync(599))
    expect(activeTab().loc.path).toBe('/photos')
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(activeTab().loc.path).toBe('C:\\work')

    // 사이드바 장소도 같은 규칙: 활성 탭이 그 장소로 간다.
    act(() => useDnd.setState({ over: null }))
    fireEvent.dragOver(screen.getByRole('button', { name: 'Downloads' }), { dataTransfer: dt() })
    await act(() => vi.advanceTimersByTimeAsync(599))
    expect(activeTab().loc.path).toBe('C:\\work')
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(activeTab().loc.path).toBe('C:\\Users\\me\\Downloads')

    // 폴더 타일도 같은 훅이다.
    act(() => useDnd.setState({ over: null }))
    fireEvent.click(tab('photos'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    fireEvent.dragOver(option('sub'), { dataTransfer: dt() })
    await act(() => vi.advanceTimersByTimeAsync(599))
    expect(activeTab().loc.path).toBe('/photos')
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(activeTab().loc.path).toBe('/photos/sub')
  })
})

describe('TabStrip — the new-tab menu opened by a real click', () => {
  // act 밖의 네이티브 click. jsdom에는 리스너 사이 마이크로태스크 체크포인트가 없어 이 테스트는
  // 고치기 전에도 통과한다(회귀 방어, explorer-menu-and-focus §8 함정 1). RED 증거는 R3 (a).
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  let saved: boolean | undefined
  beforeEach(() => {
    h = setupExplorer()
    useTabsStore.getState().openTab(localLoc('C:\\work'))
    saved = env.IS_REACT_ACT_ENVIRONMENT
    env.IS_REACT_ACT_ENVIRONMENT = false
  })
  afterEach(() => {
    env.IS_REACT_ACT_ENVIRONMENT = saved
  })
  const nativeClick = (el: Element): void => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }
  /** 비동기 openMenu(`await loadPlaces()`)와 그 뒤의 렌더가 끝나도록 매크로태스크 몇 번을 넘긴다. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
  }

  it('keeps the + menu open, closes it on an outside click and duplicates the tab from it', async () => {
    // covers: Test-850
    render(<TabStrip />)
    const plus = screen.getByRole('button', { name: en['tabs.new'] })
    nativeClick(plus)
    await settle()
    expect(screen.getByRole('menu', { name: en['tabs.new'] })).toBeTruthy()

    nativeClick(document.body)
    await settle()
    expect(screen.queryByRole('menu')).toBeNull()

    nativeClick(plus)
    await settle()
    const menu = screen.getByRole('menu', { name: en['tabs.new'] })
    nativeClick(within(menu).getByRole('menuitem', { name: new RegExp(en['tabs.duplicate']) }))
    await settle()
    expect(paths()).toEqual(['C:\\work', 'C:\\work'])
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
