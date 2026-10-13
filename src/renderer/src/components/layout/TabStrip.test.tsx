/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { en } from '@renderer/i18n/locales/en'
import { fromFtpEntry, type Loc } from '@renderer/lib/explorerEntry'
import { useFtpStore } from '@renderer/stores/useFtpStore'
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
  setConnection,
  setupExplorer,
  stubRect,
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
  it('lists a root for every connected server in the + menu, in connection order', async () => {
    // covers: Test-1039
    const [A, B, C, D] = ['a@a.lan:21', 'b@b.lan:21', 'c@c.lan:21', 'd@d.lan:21']
    useFtpStore.setState({ connections: {} })
    setConnection(A, 'connected')
    setConnection(B, 'connected')
    setConnection(C, 'disconnected')
    setConnection(D, 'connecting')
    render(<TabStrip />)
    nativeClick(screen.getByRole('button', { name: en['tabs.new'] }))
    await settle()
    const menu = screen.getByRole('menu', { name: en['tabs.new'] })
    const rows = Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]')).map(
      (el) => (el.getAttribute('role') === 'separator' ? '—' : (el.textContent ?? ''))
    )
    expect(rows.slice(0, 4)).toEqual([
      expect.stringMatching(/^This PC › me/),
      expect.stringMatching(/^a\.lan:21 › /),
      expect.stringMatching(/^b\.lan:21 › /),
      '—'
    ])
    expect(rows.some((r) => /c\.lan|d\.lan/.test(r))).toBe(false)
    expect(rows[4]).toMatch(new RegExp(en['tabs.duplicate']))

    nativeClick(within(menu).getByRole('menuitem', { name: /^b\.lan:21 › / }))
    await settle()
    expect(activeTab().loc).toEqual({ side: 'remote', path: '/', server: B })

    // 연결된 서버가 없으면 원격 항목이 없다
    useFtpStore.setState({ connections: {} })
    nativeClick(screen.getByRole('button', { name: en['tabs.new'] }))
    await settle()
    const empty = screen.getByRole('menu', { name: en['tabs.new'] })
    expect(within(empty).queryAllByRole('menuitem', { name: /lan:21/ })).toEqual([])
  })
})

// ---------- 분할 보기: 묶음 알약·탭 메뉴·탭 드래그(split-view §5, SV4) ----------

const W = 'C:\\work'
const named = (n: string): Loc => localLoc(`${W}\\${n}`)
/** 이름마다 탭을 연다(첫 탭이 활성). 이름 → 탭 id */
function openNamed(...names: string[]): Record<string, string> {
  const ids: Record<string, string> = {}
  names.forEach((n, i) => {
    ids[n] = useTabsStore.getState().openTab(named(n), i === 0)
  })
  return ids
}
const order = (ids: Record<string, string>): string[] => {
  const byId = Object.fromEntries(Object.entries(ids).map(([n, id]) => [id, n]))
  return useTabsStore.getState().tabs.map((t) => byId[t.id])
}
const splitOf = (ids: Record<string, string>): string[] | null => {
  const s = useTabsStore.getState().split
  if (!s) return null
  const byId = Object.fromEntries(Object.entries(ids).map(([n, id]) => [id, n]))
  return [byId[s.leftId], byId[s.rightId]]
}
const activeName = (ids: Record<string, string>): string | undefined =>
  Object.entries(ids).find(([, id]) => id === useTabsStore.getState().activeId)?.[0]

function setupNamed(...names: string[]): Record<string, string> {
  h = setupExplorer({ local: Object.fromEntries(names.map((n) => [`${W}\\${n}`, []])) })
  return openNamed(...names)
}

async function renderShell(): Promise<void> {
  render(
    <>
      <TabStrip />
      <Explorer />
    </>
  )
  await flush()
  layout()
}

/**
 * 탭줄 rect(bottom 48)·`[data-split-root]` rect(0,48,1000×600)·단위(탭 또는 묶음 알약) rect를 고정한다.
 * 단위는 왼쪽부터 탭 하나에 90px, 사이 10px. 상태가 바뀌어 단위가 다시 그려지면 다시 부른다.
 */
function layout(): void {
  const strip = document.querySelector('[data-tab-strip]')
  if (strip) stubRect(strip, { left: 0, top: 0, width: 1000, height: 48 })
  const root = document.querySelector('[data-split-root]')
  if (root) stubRect(root, { left: 0, top: 48, width: 1000, height: 600 })
  let x = 0
  document.querySelectorAll('[data-tab-unit]').forEach((el) => {
    const width = el.querySelectorAll('[role="tab"]').length * 90
    stubRect(el, { left: x, top: 6, width, height: 36 })
    x += width + 10
  })
}

const pointer = (x: number, y: number): Record<string, number> => ({
  button: 0,
  pointerId: 1,
  clientX: x,
  clientY: y
})
const down = (el: HTMLElement, x: number, y = 20): void => {
  fireEvent.pointerDown(el, pointer(x, y))
}
const move = (x: number, y: number): void => {
  fireEvent.pointerMove(window, pointer(x, y))
}
const up = (x: number, y: number): void => {
  fireEvent.pointerUp(window, pointer(x, y))
}
/** 탭을 누르고 5px 움직여 드래그를 시작한다(탭줄 안). */
const startDrag = (el: HTMLElement, x: number): void => {
  down(el, x)
  move(x + 5, 20)
}
const ghost = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="tab-drag-ghost"]')
const indicator = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="tab-drop-indicator"]')
const zoneEl = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-zone]')
const wait = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('TabStrip — split pair pill and tab menu', () => {
  it('draws the split pair as one group with the active half selected, kept while the pair is hidden', async () => {
    // covers: Test-1071
    const ids = setupNamed('A', 'B', 'C', 'D')
    useTabsStore.setState({ split: { leftId: ids.C, rightId: ids.D, ratio: 0.5 }, activeId: ids.D })
    await renderShell()
    const group = screen.getByRole('group', { name: 'Split view: C and D' })
    expect(
      within(group)
        .getAllByRole('tab')
        .map((el) => el.dataset.tab)
    ).toEqual([ids.C, ids.D])
    expect(tab('D').getAttribute('aria-selected')).toBe('true')
    expect(tab('C').getAttribute('aria-selected')).toBe('false')
    expect(tabs().filter((el) => el.getAttribute('aria-selected') === 'true')).toHaveLength(1)

    fireEvent.click(tab('A'))
    const still = screen.getByRole('group', { name: 'Split view: C and D' })
    expect(
      within(still)
        .getAllByRole('tab')
        .map((el) => el.getAttribute('aria-selected'))
    ).toEqual(['false', 'false'])
    expect(tab('A').getAttribute('aria-selected')).toBe('true')
  })

  it('splits a plain tab to the right from its context menu, by right click, Shift+F10 or the menu key', async () => {
    // covers: Test-1072
    const ids = setupNamed('A', 'B')
    await renderShell()
    fireEvent.contextMenu(tab('B'))
    const menu = screen.getByRole('menu')
    const item = within(menu).getByRole('menuitem', { name: en['split.menuSplitRight'] })
    expect(item.getAttribute('aria-keyshortcuts')).toBe('Ctrl+\\')
    fireEvent.click(item)
    expect(splitOf(ids)).toEqual(['A', 'B'])
    expect(activeName(ids)).toBe('B')
    expect(screen.queryByRole('menu')).toBeNull()
    await flush()
    expect(document.activeElement).toBe(document.getElementById(`explorer-list-${ids.B}`))

    // 키보드 대체 경로: 탭에 포커스를 두고 Shift+F10·메뉴 키
    act(() => useTabsStore.setState({ split: null, activeId: ids.A }))
    tab('B').focus()
    fireEvent.keyDown(tab('B'), { key: 'F10', shiftKey: true })
    expect(
      within(screen.getByRole('menu')).getByRole('menuitem', { name: en['split.menuSplitRight'] })
    ).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    tab('B').focus()
    fireEvent.keyDown(tab('B'), { key: 'ContextMenu' })
    expect(
      within(screen.getByRole('menu')).getByRole('menuitem', { name: en['split.menuSplitRight'] })
    ).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    // 탭이 하나면 비활성
    act(() => useTabsStore.getState().closeTab(ids.B))
    fireEvent.contextMenu(tab('A'))
    const only = within(screen.getByRole('menu')).getByRole('menuitem', {
      name: en['split.menuSplitRight']
    }) as HTMLButtonElement
    expect(only.disabled).toBe(true)
  })

  it('moves the tab menu to a second right-clicked tab and gives focus back to the tab when it closes', async () => {
    // covers: Test-1072
    setupNamed('A', 'B')
    await renderShell()
    fireEvent.contextMenu(tab('A'))
    fireEvent.contextMenu(tab('B'))
    await flush()
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.getByRole('menu').getAttribute('aria-label')).toBe('B')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    // 키보드로 연 메뉴를 Esc로 닫으면 연 탭으로 돌아간다(탭 목록에서 자리를 잃지 않는다).
    tab('B').focus()
    fireEvent.keyDown(tab('B'), { key: 'F10', shiftKey: true })
    await flush()
    expect(screen.getByRole('menu').contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(tab('B'))
  })

  it('gives focus back to the half after Swap sides or Unsplit redraws the pair', async () => {
    // covers: Test-1072
    // 메뉴 항목이 탭줄을 다시 그리면(반쪽 버튼이 옮겨지거나 다시 마운트되면) 포커스가 body로 빠졌다.
    const ids = setupNamed('A', 'C', 'D')
    useTabsStore.setState({ split: { leftId: ids.C, rightId: ids.D, ratio: 0.5 }, activeId: ids.C })
    await renderShell()
    const pick = async (name: string): Promise<void> => {
      tab('D').focus()
      fireEvent.keyDown(tab('D'), { key: 'F10', shiftKey: true })
      await flush()
      fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name }))
      await flush()
    }
    await pick(en['split.swap'])
    expect(splitOf(ids)).toEqual(['D', 'C'])
    expect(document.activeElement).toBe(tab('D'))
    await pick(en['split.unsplit'])
    expect(useTabsStore.getState().split).toBeNull()
    expect(document.activeElement).toBe(tab('D'))
  })

  it('offers only Unsplit and Swap sides on a half of the pair', async () => {
    // covers: Test-1073
    const ids = setupNamed('A', 'C', 'D')
    useTabsStore.setState({ split: { leftId: ids.C, rightId: ids.D, ratio: 0.5 }, activeId: ids.C })
    await renderShell()
    fireEvent.contextMenu(tab('D'))
    const menu = screen.getByRole('menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((el) => el.textContent)
    ).toEqual([en['split.unsplit'], en['split.swap']])
    fireEvent.click(within(menu).getByRole('menuitem', { name: en['split.unsplit'] }))
    expect(useTabsStore.getState().split).toBeNull()

    act(() =>
      useTabsStore.setState({
        split: { leftId: ids.C, rightId: ids.D, ratio: 0.5 },
        activeId: ids.C
      })
    )
    fireEvent.contextMenu(tab('C'))
    fireEvent.click(
      within(screen.getByRole('menu')).getByRole('menuitem', { name: en['split.swap'] })
    )
    expect(splitOf(ids)).toEqual(['D', 'C'])
    expect(order(ids)).toEqual(['A', 'D', 'C'])
  })

  it('unsplits when a half is closed by its close button or Ctrl+W, activating the other half', async () => {
    // covers: Test-1074
    const ids = setupNamed('A', 'C', 'D', 'E')
    useTabsStore.setState({ split: { leftId: ids.C, rightId: ids.D, ratio: 0.5 }, activeId: ids.C })
    await renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Close C tab' }))
    expect(order(ids)).toEqual(['A', 'D', 'E'])
    expect(useTabsStore.getState().split).toBeNull()
    expect(activeName(ids)).toBe('D')

    // 오른쪽 반쪽이 활성인 짝: 지금 규칙의 다음 탭(E)이 아니라 짝의 다른 반쪽(A)
    act(() =>
      useTabsStore.setState({
        split: { leftId: ids.A, rightId: ids.D, ratio: 0.5 },
        activeId: ids.D
      })
    )
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true })
    expect(order(ids)).toEqual(['A', 'E'])
    expect(useTabsStore.getState().split).toBeNull()
    expect(activeName(ids)).toBe('A')
  })
  it('moves focus to the other half when the focused active half closes', async () => {
    // covers: Test-1074
    const ids = setupNamed('A', 'C', 'D')
    useTabsStore.setState({ split: { leftId: ids.C, rightId: ids.D, ratio: 0.5 }, activeId: ids.D })
    await renderShell()
    act(() => document.getElementById(`explorer-list-${ids.D}`)?.focus())
    expect(document.activeElement?.id).toBe(`explorer-list-${ids.D}`)
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true })
    await flush()
    expect(activeName(ids)).toBe('C')
    expect(document.activeElement).toBe(document.getElementById(`explorer-list-${ids.C}`))
  })
})

describe('TabStrip — tab drag', () => {
  it('treats a move under 4px as a click and reorders a dragged tab with a ghost, swallowing the click after it', async () => {
    // covers: Test-1075
    const ids = setupNamed('A', 'B', 'C')
    await renderShell()
    down(tab('B'), 100)
    move(103, 20)
    expect(ghost()).toBeNull()
    up(103, 20)
    fireEvent.click(tab('B'))
    expect(activeName(ids)).toBe('B')

    act(() => useTabsStore.getState().activate(ids.A))
    down(tab('B'), 100)
    move(104, 20)
    expect(ghost()?.parentElement).toBe(document.body)
    expect(ghost()?.textContent).toContain('B')
    move(400, 20)
    up(400, 20)
    fireEvent.click(tab('B'))
    expect(order(ids)).toEqual(['A', 'C', 'B'])
    expect(ghost()).toBeNull()
    expect(activeName(ids)).toBe('A')
  })

  it('shows the drop indicator at the insertion index, cancels on Esc and moves a split pair as one unit', async () => {
    // covers: Test-1076
    const ids = setupNamed('A', 'B', 'C', 'D')
    useTabsStore.setState({ split: { leftId: ids.C, rightId: ids.D, ratio: 0.5 }, activeId: ids.A })
    await renderShell()
    // 단위: A 0~90(가운데 45), B 100~190(145), [C|D] 200~380(290)
    startDrag(tab('A'), 45)
    move(160, 20)
    expect(indicator()?.dataset.index).toBe('2')
    expect(indicator()?.style.left).toBe('197px')
    move(10, 20)
    expect(indicator()?.dataset.index).toBe('0')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(indicator()).toBeNull()
    expect(ghost()).toBeNull()
    up(10, 20)
    expect(order(ids)).toEqual(['A', 'B', 'C', 'D'])

    startDrag(tab('C'), 245)
    move(10, 20)
    up(10, 20)
    expect(order(ids)).toEqual(['C', 'D', 'A', 'B'])
    expect(splitOf(ids)).toEqual(['C', 'D'])
  })

  it('arms the right zone after 60 ms below the strip and splits on release', async () => {
    // covers: Test-1077
    const ids = setupNamed('A', 'B')
    await renderShell()
    vi.useFakeTimers()
    startDrag(tab('B'), 145)
    move(900, 65)
    wait(59)
    expect(zoneEl()).toBeNull()
    wait(1)
    expect(zoneEl()?.dataset.zone).toBe('right')
    const chip = screen.getByText('Split right · B')
    expect(chip.parentElement?.querySelector('.lucide-laptop')).toBeTruthy()
    expect(screen.getByText('Remaining: A')).toBeTruthy()
    const overlay = screen.getByTestId('split-overlay')
    expect(overlay.getAttribute('aria-hidden')).toBe('true')
    expect(overlay.className).toContain('pointer-events-none')
    expect(overlay.contains(zoneEl())).toBe(true)

    up(900, 65)
    expect(splitOf(ids)).toEqual(['A', 'B'])
    expect(activeName(ids)).toBe('B')
    expect(document.querySelectorAll('section[data-pane]')).toHaveLength(2)
    expect(zoneEl()).toBeNull()
  })

  it('cancels a split drag in the centre, on a zone change, on Esc, back in the strip, on blur and outside the window', async () => {
    // covers: Test-1078
    const ids = setupNamed('A', 'B')
    await renderShell()
    vi.useFakeTimers()
    const unchanged = (): void => {
      expect(useTabsStore.getState().split).toBeNull()
      expect(order(ids)).toEqual(['A', 'B'])
    }

    // 가운데 존에서 놓기
    startDrag(tab('B'), 145)
    move(500, 65)
    wait(60)
    expect(zoneEl()).toBeNull()
    up(500, 65)
    unchanged()

    // 오른쪽에서 50ms 뒤 왼쪽으로: 그때부터 60ms
    startDrag(tab('B'), 145)
    move(900, 65)
    wait(50)
    move(100, 65)
    wait(59)
    expect(zoneEl()).toBeNull()
    wait(1)
    expect(zoneEl()?.dataset.zone).toBe('left')
    move(500, 65)
    expect(zoneEl()).toBeNull()
    up(500, 65)
    unchanged()

    // 오버레이가 뜬 뒤 Esc
    startDrag(tab('B'), 145)
    move(900, 65)
    wait(60)
    expect(zoneEl()).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(zoneEl()).toBeNull()
    expect(ghost()).toBeNull()
    up(900, 65)
    // 손을 떼면 캡처한 탭 버튼에 click이 온다. 취소한 드래그도 활성 탭을 바꾸지 않는다.
    fireEvent.click(tab('B'))
    expect(activeName(ids)).toBe('A')
    unchanged()

    // 탭줄로 올라오면 순서 변경만
    startDrag(tab('A'), 45)
    move(900, 65)
    wait(60)
    expect(zoneEl()).not.toBeNull()
    move(900, 40)
    expect(zoneEl()).toBeNull()
    expect(indicator()).not.toBeNull()
    up(900, 40)
    expect(useTabsStore.getState().split).toBeNull()
    expect(order(ids)).toEqual(['B', 'A'])
    act(() => useTabsStore.getState().moveTab(ids.A, ids.B))
    layout()

    // window blur
    startDrag(tab('B'), 145)
    move(900, 65)
    wait(60)
    expect(zoneEl()).not.toBeNull()
    fireEvent.blur(window)
    expect(zoneEl()).toBeNull()
    expect(ghost()).toBeNull()
    up(900, 65)
    fireEvent.click(tab('B'))
    expect(activeName(ids)).toBe('A')
    unchanged()

    // 창 밖
    startDrag(tab('B'), 145)
    move(900, 65)
    wait(60)
    expect(zoneEl()).not.toBeNull()
    move(-5, 65)
    expect(zoneEl()).toBeNull()
    wait(1000)
    expect(zoneEl()).toBeNull()
    up(-5, 65)
    unchanged()

    // 탭줄 위로 창 밖(순서 변경 모드): 표시선이 사라지고 놓아도 순서 그대로
    startDrag(tab('B'), 145)
    move(10, 20)
    expect(indicator()).not.toBeNull()
    move(10, -5)
    expect(indicator()).toBeNull()
    up(10, -5)
    unchanged()

    // 키보드 click은 막지 않는다(취소 뒤의 click 무시는 그 한 번뿐).
    wait(1)
    fireEvent.click(tab('B'))
    expect(activeName(ids)).toBe('B')
  })

  it('keeps the painted zone across a left-right switch so it slides, and fades it while unarmed', async () => {
    // covers: Test-1077
    setupNamed('A', 'B')
    await renderShell()
    vi.useFakeTimers()
    const painted = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('.split-overlay-zone')
    startDrag(tab('B'), 145)
    move(900, 65)
    wait(60)
    const zone = painted()
    expect(zone?.dataset.zone).toBe('right')
    expect(zone?.style.opacity).toBe('1')
    expect(zone?.style.left).toBe('500px')
    expect(zone?.style.transition).toContain('left')

    // 존이 바뀌면 무장이 풀린다: 같은 요소가 제자리에서 흐려진다.
    move(100, 65)
    expect(painted()).toBe(zone)
    expect(zone?.dataset.zone).toBeUndefined()
    expect(zone?.style.opacity).toBe('0')
    expect(zone?.style.left).toBe('500px')

    // 다시 무장되면 같은 요소가 왼쪽으로 옮겨 간다(위치 transition이 움직인다).
    wait(60)
    expect(painted()).toBe(zone)
    expect(zone?.dataset.zone).toBe('left')
    expect(zone?.style.left).toBe('0px')
    expect(zone?.style.opacity).toBe('1')
    expect(screen.getByText('Split left · B')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(painted()).toBeNull()
  })

  it('never shows the overlay with a single tab', async () => {
    // covers: Test-1079
    setupNamed('A')
    await renderShell()
    vi.useFakeTimers()
    startDrag(tab('A'), 45)
    move(900, 65)
    wait(1000)
    expect(zoneEl()).toBeNull()
    up(900, 65)
    expect(useTabsStore.getState().split).toBeNull()
  })

  it('replaces or swaps panes by zone while split, with the centre zone cancelling', async () => {
    // covers: Test-1080
    const ids = setupNamed('A', 'B', 'C')
    useTabsStore.setState({ split: { leftId: ids.A, rightId: ids.B, ratio: 0.4 }, activeId: ids.A })
    await renderShell()
    vi.useFakeTimers()
    // 단위: [A|B] 0~180(가운데 90), C 190~280(235)

    // ① 가운데 존 = 취소
    startDrag(tab('C'), 235)
    move(800, 65)
    wait(60)
    expect(zoneEl()?.dataset.zone).toBe('right')
    move(360, 65)
    expect(zoneEl()).toBeNull()
    wait(1000)
    expect(zoneEl()).toBeNull()
    up(360, 65)
    expect(splitOf(ids)).toEqual(['A', 'B'])
    expect(useTabsStore.getState().split?.ratio).toBe(0.4)
    expect(order(ids)).toEqual(['A', 'B', 'C'])
    expect(activeName(ids)).toBe('A')

    // ② 오른쪽 존 = 오른쪽 패널 교체. 칠하는 곳은 오른쪽 패널 영역
    startDrag(tab('C'), 235)
    move(800, 65)
    wait(60)
    const zone = zoneEl()
    expect(zone?.dataset.zone).toBe('right')
    expect(zone?.style.left).toBe('400px')
    expect(zone?.style.width).toBe('600px')
    expect(screen.getByText('Open here · C')).toBeTruthy()
    expect(screen.getByText('Remaining: A')).toBeTruthy()
    up(800, 65)
    expect(splitOf(ids)).toEqual(['A', 'C'])
    expect(activeName(ids)).toBe('C')
    layout()

    // ③ 반쪽을 자기 패널로: 할 일이 없다. 반대 패널로: 좌우 바꾸기
    startDrag(tab('A'), 45)
    move(200, 65)
    wait(1000)
    expect(zoneEl()).toBeNull()
    up(200, 65)
    expect(splitOf(ids)).toEqual(['A', 'C'])

    startDrag(tab('A'), 45)
    move(800, 65)
    wait(60)
    expect(screen.getByText(en['split.swap'])).toBeTruthy()
    up(800, 65)
    expect(splitOf(ids)).toEqual(['C', 'A'])
  })
})
