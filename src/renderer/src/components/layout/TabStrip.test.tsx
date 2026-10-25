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

describe('TabStrip — one strip per pane', () => {
  it('shows only its own pane’s tabs and selects that pane’s own active tab', () => {
    // covers: Test-920
    h = setupExplorer()
    useTabsStore.setState({
      tabs: [],
      activeId: '',
      recent: [],
      panes: [{ id: 'pane1', tabIds: [], activeTabId: '' }]
    })
    const s = useTabsStore.getState()
    const workId = s.openTab(localLoc('C:\\work'))
    const musicId = s.openTab(localLoc('C:\\music'), false)
    const pane2Id = s.split('pane1')
    const placeholder = useTabsStore.getState().panes[1].activeTabId
    // split() 뒤에는 pane2가 포커스라 새 탭도 그 패널에 연다(M11).
    const photosId = useTabsStore.getState().openTab(remoteLoc('/photos'))
    expect(useTabsStore.getState().activeId).toBe(photosId)

    render(
      <>
        <TabStrip paneId="pane1" />
        <TabStrip paneId={pane2Id} />
      </>
    )
    const strips = (): HTMLElement[] => screen.getAllByRole('tablist')
    const ids = (list: HTMLElement): string[] =>
      within(list)
        .getAllByRole('tab')
        .map((t) => t.dataset.tab as string)
    const selected = (list: HTMLElement): string | undefined =>
      within(list)
        .getAllByRole('tab')
        .find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.tab

    // 각 스트립은 자기 패널의 탭만 보여준다.
    expect(ids(strips()[0])).toEqual([workId, musicId])
    expect(ids(strips()[1])).toEqual([placeholder, photosId])
    // 활성 탭 선택도 패널마다 다르다.
    expect(selected(strips()[0])).toBe(workId)
    expect(selected(strips()[1])).toBe(photosId)

    // 한 패널의 활성 탭을 바꿔도 다른 패널의 선택은 그대로다.
    act(() => useTabsStore.getState().activate(musicId))
    expect(selected(strips()[0])).toBe(musicId)
    expect(selected(strips()[1])).toBe(photosId)
    act(() => useTabsStore.getState().activate(placeholder))
    expect(selected(strips()[0])).toBe(musicId)
    expect(selected(strips()[1])).toBe(placeholder)
  })
})

describe('TabStrip — closing the split', () => {
  it('closes the second pane from its strip control and keeps the remaining pane’s tabs', () => {
    // covers: Test-937
    h = setupExplorer()
    useTabsStore.setState({
      tabs: [],
      activeId: '',
      recent: [],
      panes: [{ id: 'pane1', tabIds: [], activeTabId: '' }]
    })
    const workId = useTabsStore.getState().openTab(localLoc('C:\\work'))
    const pane2Id = useTabsStore.getState().split('pane1')
    const placeholder = useTabsStore.getState().panes[1].activeTabId
    // split() 직후라 새 패널이 포커스다 — 새 탭도 그 패널에 연다(M11).
    const musicId = useTabsStore.getState().openTab(localLoc('C:\\music'))

    render(
      <>
        <TabStrip paneId="pane1" />
        <TabStrip paneId={pane2Id} />
      </>
    )
    const strips = screen.getAllByRole('tablist')
    const close = screen.getAllByRole('button', { name: en['split.closePane'] })
    // M21: 두 패널일 때 두 번째 패널의 스트립에 닫기控件이 하나만 뜬다.
    expect(close).toHaveLength(1)
    expect(strips[1].parentElement?.contains(close[0])).toBe(true)

    fireEvent.click(close[0])
    // 한 패널로 돌아오고 남은 패널의 탭은 그대로다(M12·Test-919의 제품 트리거).
    const s = useTabsStore.getState()
    expect(s.panes).toHaveLength(1)
    expect(s.panes[0].id).toBe('pane1')
    expect(s.tabs.map((t) => t.id)).toEqual([workId, placeholder, musicId])
    expect(s.tabs.every((t) => t.paneId === 'pane1')).toBe(true)
    expect(s.activeId).toBe(workId)
  })
})
