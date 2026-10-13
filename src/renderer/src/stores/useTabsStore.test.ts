import { beforeEach, describe, expect, it } from 'vitest'
import { activePane, useTabsStore, visiblePanes, type Tab } from './useTabsStore'
import { useSettingsStore } from './useSettingsStore'
import type { Loc } from '@renderer/lib/explorerEntry'

const home: Loc = { side: 'local', path: 'C:\\Users\\me' }
const remote = (path: string, server = 'me@h:21'): Loc => ({ side: 'remote', path, server })

const tabs = (): Tab[] => useTabsStore.getState().tabs
const active = (): Tab => {
  const s = useTabsStore.getState()
  return s.tabs.find((t) => t.id === s.activeId)!
}

beforeEach(() => {
  useTabsStore.setState({ tabs: [], activeId: '', recent: [], split: null })
  useTabsStore.getState().openTab(home)
})

describe('useTabsStore navigation', () => {
  it('navigate pushes back history (max 50), clears forward/selection/find and records recent', () => {
    // covers: Test-781
    const { navigate, patchTab } = useTabsStore.getState()
    navigate({ side: 'local', path: 'C:\\a' })
    useTabsStore.getState().goBack()
    expect(active().fwd).toHaveLength(1)
    patchTab(active().id, { sel: ['C:\\Users\\me\\x'], query: 'x' })

    navigate({ side: 'local', path: 'C:\\b' })
    expect(active()).toMatchObject({
      loc: { side: 'local', path: 'C:\\b' },
      back: [home],
      fwd: [],
      sel: [],
      query: ''
    })
    // Navigating to the same place is a no-op.
    navigate({ side: 'local', path: 'C:\\b' })
    expect(active().back).toHaveLength(1)

    for (let i = 0; i < 60; i++) navigate({ side: 'local', path: `C:\\n${i}` })
    expect(active().back).toHaveLength(50)

    // Recent: left locations, newest first, no duplicates, at most 6.
    const recent = useTabsStore.getState().recent
    expect(recent).toHaveLength(6)
    expect(recent[0]).toEqual({ side: 'local', path: 'C:\\n58' })
    navigate({ side: 'local', path: 'C:\\n58' })
    navigate({ side: 'local', path: 'C:\\z' })
    const after = useTabsStore.getState().recent
    expect(after[0]).toEqual({ side: 'local', path: 'C:\\n58' })
    expect(after.filter((l) => l.path === 'C:\\n58')).toHaveLength(1)
  })

  it('goBack to the parent and goUp select the folder left; goForward clears the selection', () => {
    // covers: Test-782
    const s = useTabsStore.getState()
    s.navigate({ side: 'local', path: 'C:\\Users\\me\\photos' })
    s.goBack()
    expect(active().loc.path).toBe('C:\\Users\\me')
    expect(active()).toMatchObject({
      sel: ['C:\\Users\\me\\photos'],
      focus: 'C:\\Users\\me\\photos',
      anchor: 'C:\\Users\\me\\photos'
    })

    s.goForward()
    expect(active()).toMatchObject({ loc: { path: 'C:\\Users\\me\\photos' }, sel: [], focus: null })

    s.goUp()
    expect(active()).toMatchObject({
      loc: { path: 'C:\\Users\\me' },
      sel: ['C:\\Users\\me\\photos']
    })

    // Back to a non-parent selects nothing.
    s.navigate({ side: 'local', path: 'D:\\x' })
    s.goBack()
    expect(active().sel).toEqual([])

    // Remote parent of the root is nothing.
    s.navigate(remote('/'))
    s.goUp()
    expect(active().loc).toEqual(remote('/'))
  })

  it('openTab inherits the view; closeTab keeps the last tab and picks the neighbor; cycleTab wraps', () => {
    // covers: Test-783
    useSettingsStore.setState({ viewMode: 'list' })
    useTabsStore.setState({ tabs: [], activeId: '' })
    const s = useTabsStore.getState()
    const first = s.openTab(home)
    expect(active().view).toBe('list')
    s.patchTab(first, { view: 'grid' })
    const second = s.openTab(remote('/'))
    expect(active()).toMatchObject({ id: second, view: 'grid' })
    const third = s.openTab(remote('/x'), false)
    expect(useTabsStore.getState().activeId).toBe(second)

    s.cycleTab(1)
    expect(useTabsStore.getState().activeId).toBe(third)
    s.cycleTab(1)
    expect(useTabsStore.getState().activeId).toBe(first)
    s.cycleTab(-1)
    expect(useTabsStore.getState().activeId).toBe(third)

    // Closing the active tab activates the one that takes its place, else the one before.
    s.activate(second)
    s.closeTab(second)
    expect(useTabsStore.getState().activeId).toBe(third)
    s.closeTab(third)
    expect(useTabsStore.getState().activeId).toBe(first)
    s.closeTab(first)
    expect(tabs().map((t) => t.id)).toEqual([first])

    // Closing an inactive tab keeps the active one.
    const other = s.openTab(remote('/y'), false)
    s.closeTab(other)
    expect(useTabsStore.getState().activeId).toBe(first)
  })

  it('keeps selection, focus, scroll, sort and view per tab across switches', () => {
    // covers: Test-784
    const s = useTabsStore.getState()
    const a = active().id
    s.patchTab(a, {
      sel: ['C:\\Users\\me\\x'],
      focus: 'C:\\Users\\me\\x',
      view: 'list',
      sort: { key: 'size', dir: 'desc', foldersFirst: false }
    })
    s.patchTab(a, (t) => ({ scroll: { ...t.scroll, [t.loc.path]: 420 } }))
    const b = s.openTab(remote('/'))
    s.patchTab(b, { sel: ['/y'] })
    s.activate(a)

    expect(active()).toMatchObject({
      sel: ['C:\\Users\\me\\x'],
      focus: 'C:\\Users\\me\\x',
      view: 'list',
      sort: { key: 'size', dir: 'desc', foldersFirst: false },
      scroll: { 'C:\\Users\\me': 420 }
    })
    expect(tabs().find((t) => t.id === b)!.sel).toEqual(['/y'])
  })

  it('keeps the type filter per tab: empty on a new tab, not inherited, and kept across navigation', () => {
    // covers: Test-937
    const a = active().id
    expect(active().filter).toEqual({ categories: [], extensions: [], noExtension: false })
    expect(active()).not.toHaveProperty('photosOnly')

    const filter = { categories: ['image'], extensions: ['log'], noExtension: true }
    const s = useTabsStore.getState()
    const b = s.openTab(remote('/'), false)
    s.patchTab(a, { filter })
    expect(tabs().find((t) => t.id === b)!.filter).toEqual({
      categories: [],
      extensions: [],
      noExtension: false
    })
    const c = s.openTab(remote('/c'))
    expect(tabs().find((t) => t.id === c)!.filter.categories).toEqual([])

    s.activate(a)
    s.patchTab(a, { query: 'x' })
    s.navigate({ side: 'local', path: 'C:\\a' })
    expect(active().query).toBe('')
    expect(active().filter).toBe(filter)
    s.goBack()
    expect(active().filter).toBe(filter)
    s.goForward()
    expect(active().filter).toBe(filter)
    s.goUp()
    expect(active().filter).toBe(filter)
  })

  it("adoptRemote moves only a tab of that server, else opens one, and never another server's tab", () => {
    // covers: Test-1014
    const s = useTabsStore.getState()
    const local = active().id
    const B = 'you@other:2121'

    // No tab of B: a new one, activated.
    s.adoptRemote(B, '/home')
    expect(tabs()).toHaveLength(2)
    expect(active().loc).toEqual(remote('/home', B))
    const b1 = active().id

    // The active tab is A's remote tab: it stays where it is; B's first remote tab moves.
    const a1 = s.openTab(remote('/a'))
    const b2 = s.openTab(remote('/b2', B), false)
    s.adoptRemote(B, '/start')
    expect(useTabsStore.getState().activeId).toBe(b1)
    expect(tabs().find((t) => t.id === b1)!.loc).toEqual(remote('/start', B))
    expect(tabs().find((t) => t.id === a1)!.loc).toEqual(remote('/a'))
    expect(tabs().find((t) => t.id === b2)!.loc).toEqual(remote('/b2', B))

    // The active tab is B's remote tab: that one.
    s.activate(b2)
    s.adoptRemote(B, '/again')
    expect(useTabsStore.getState().activeId).toBe(b2)
    expect(active().loc).toEqual(remote('/again', B))
    expect(tabs().find((t) => t.id === b1)!.loc).toEqual(remote('/start', B))
    expect(tabs()).toHaveLength(4)

    // activate: false (an agent connect) moves B's first tab but keeps the active one.
    s.activate(local)
    s.adoptRemote(B, '/agent', { activate: false })
    expect(useTabsStore.getState().activeId).toBe(local)
    expect(tabs().find((t) => t.id === b1)!.loc).toEqual(remote('/agent', B))
    expect(tabs().find((t) => t.id === a1)!.loc).toEqual(remote('/a'))
    // ...and a new tab for a server without one stays in the background.
    s.adoptRemote('new@n:21', '/n', { activate: false })
    expect(useTabsStore.getState().activeId).toBe(local)
    expect(tabs().at(-1)!.loc).toEqual(remote('/n', 'new@n:21'))
  })
})

/** 원격 탭 `n`개를 새로 연다(첫 탭이 활성, 분할 없음). 탭 id를 순서대로 돌려준다. */
const fresh = (n: number): string[] => {
  useTabsStore.setState({ tabs: [], activeId: '', recent: [], split: null })
  const { openTab } = useTabsStore.getState()
  return Array.from({ length: n }, (_, i) => openTab(remote(`/t${i}`), i === 0))
}
const order = (): string[] => tabs().map((t) => t.id)
const state = (): ReturnType<typeof useTabsStore.getState> => useTabsStore.getState()

/** 함정 1: 짝이 있으면 순서에서 늘 붙어 있다(P4). 분할이 보이면 활성 탭은 짝의 한쪽이다. */
const expectPairAdjacent = (): void => {
  const { split } = state()
  if (!split) return
  const ids = order()
  expect(ids).toContain(split.leftId)
  expect(ids.indexOf(split.rightId)).toBe(ids.indexOf(split.leftId) + 1)
}
const expectVisibleSplit = (leftId: string, rightId: string, ratio: number): void => {
  expect(state().split).toEqual({ leftId, rightId, ratio })
  expect([leftId, rightId]).toContain(state().activeId)
  expectPairAdjacent()
}

describe('useTabsStore split view', () => {
  it('visiblePanes and activePane follow the split and the active tab', () => {
    // covers: Test-1047
    const [A, B, C] = fresh(3)
    expect(visiblePanes(state())).toEqual([{ pane: 'left', tabId: A }])
    expect(activePane(state())).toBe('left')

    useTabsStore.setState({ split: { leftId: A, rightId: B, ratio: 0.5 }, activeId: B })
    expect(visiblePanes(state())).toEqual([
      { pane: 'left', tabId: A },
      { pane: 'right', tabId: B }
    ])
    expect(activePane(state())).toBe('right')

    useTabsStore.setState({ activeId: C })
    expect(visiblePanes(state())).toEqual([{ pane: 'left', tabId: C }])
    expect(activePane(state())).toBe('left')

    useTabsStore.setState({ tabs: [], activeId: '', split: null })
    expect(visiblePanes(state())).toEqual([])
  })

  it('placeInPane without a split moves the tab next to its partner and activates it', () => {
    // covers: Test-1048
    let [A, B, C, D] = fresh(4)
    state().placeInPane(D, 'right')
    expect(order()).toEqual([A, D, B, C])
    expectVisibleSplit(A, D, 0.5)
    expect(state().activeId).toBe(D)
    ;[A, B, C, D] = fresh(4)
    state().placeInPane(D, 'left')
    expect(order()).toEqual([D, A, B, C])
    expectVisibleSplit(D, A, 0.5)
    expect(state().activeId).toBe(D)
  })

  it('placeInPane of the active tab pairs it with its neighbor; one tab does nothing', () => {
    // covers: Test-1049
    let [A, B, C] = fresh(3)
    state().activate(B)
    state().placeInPane(B, 'right')
    expect(order()).toEqual([A, C, B])
    expectVisibleSplit(C, B, 0.5)
    expect(state().activeId).toBe(B)
    ;[A, B, C] = fresh(3)
    state().activate(C)
    state().placeInPane(C, 'right')
    expect(order()).toEqual([A, B, C])
    expectVisibleSplit(B, C, 0.5)

    const [only] = fresh(1)
    state().placeInPane(only, 'right')
    expect(state().split).toBeNull()
    expect(order()).toEqual([only])
    expect(state().activeId).toBe(only)
  })

  it('placeInPane while the pair is hidden dissolves it and makes the new pair', () => {
    // covers: Test-1050
    const [A, B, C, D] = fresh(4)
    useTabsStore.setState({ split: { leftId: A, rightId: B, ratio: 0.3 }, activeId: C })
    state().placeInPane(D, 'right')
    expectVisibleSplit(C, D, 0.5)
    expect(order()).toEqual([A, B, C, D])
    expect(state().activeId).toBe(D)
    expect(visiblePanes(state()).map((p) => p.tabId)).toEqual([C, D])
  })

  it('placeInPane with a visible split replaces a pane, swaps for the other half, else does nothing', () => {
    // covers: Test-1051
    const [A, B, C] = fresh(3)
    useTabsStore.setState({ split: { leftId: A, rightId: B, ratio: 0.3 }, activeId: A })

    state().placeInPane(C, 'right')
    expect(order()).toEqual([A, C, B])
    expectVisibleSplit(A, C, 0.3)
    expect(state().activeId).toBe(C)

    state().placeInPane(A, 'right')
    expect(order()).toEqual([C, A, B])
    expectVisibleSplit(C, A, 0.3)
    expect(state().activeId).toBe(A)

    const before = { tabs: tabs(), split: state().split, activeId: state().activeId }
    state().placeInPane(A, 'right')
    expect({ tabs: tabs(), split: state().split, activeId: state().activeId }).toEqual(before)
    expect(tabs()).toBe(before.tabs)
  })

  it('moveTab moves a tab or the whole pair, never between the halves', () => {
    // covers: Test-1052
    const [A, B, C, D, E] = fresh(5)
    state().moveTab(D, B)
    expect(order()).toEqual([A, D, B, C, E])
    state().moveTab(A, null)
    expect(order()).toEqual([D, B, C, E, A])

    // 짝 {B,C}: 반쪽을 옮기면 짝 전체가 순서를 지킨 채 옮겨진다.
    useTabsStore.setState({ split: { leftId: B, rightId: C, ratio: 0.5 }, activeId: B })
    state().moveTab(C, D)
    expect(order()).toEqual([B, C, D, E, A])
    expectPairAdjacent()
    state().moveTab(B, null)
    expect(order()).toEqual([D, E, A, B, C])
    expectPairAdjacent()

    // 짝 사이(beforeId = rightId)로는 짝 뒤에 들어간다.
    state().moveTab(D, C)
    expect(order()).toEqual([E, A, B, C, D])
    expectPairAdjacent()

    // 자기 자신·같은 짝의 반쪽 앞이면 아무것도 바뀌지 않는다.
    const same = tabs()
    state().moveTab(E, E)
    state().moveTab(C, B)
    state().moveTab(B, C)
    state().moveTab(B, B)
    expect(tabs()).toBe(same)
    expect(state().split).toEqual({ leftId: B, rightId: C, ratio: 0.5 })
  })

  it('unsplit, swapPanes and setSplitRatio', () => {
    // covers: Test-1053
    const [A, B, C] = fresh(3)
    useTabsStore.setState({ split: { leftId: A, rightId: B, ratio: 0.3 }, activeId: A })
    state().unsplit()
    expect(state().split).toBeNull()
    expect(order()).toEqual([A, B, C])
    expect(state().activeId).toBe(A)

    useTabsStore.setState({ split: { leftId: A, rightId: B, ratio: 0.3 }, activeId: A })
    state().swapPanes()
    expect(order()).toEqual([B, A, C])
    expectVisibleSplit(B, A, 0.3)
    expect(state().activeId).toBe(A)

    state().setSplitRatio(1.4)
    expect(state().split?.ratio).toBe(1)
    state().setSplitRatio(-0.2)
    expect(state().split?.ratio).toBe(0)
    state().setSplitRatio(0.42)
    expect(state().split).toEqual({ leftId: B, rightId: A, ratio: 0.42 })
  })

  it('closeTab of a half unsplits and activates the other half; another tab keeps the split', () => {
    // covers: Test-1054
    const prepare = (active: 'A' | 'B'): Record<'X' | 'A' | 'B' | 'Y', string> => {
      const [X, A, B, Y] = fresh(4)
      useTabsStore.setState({
        split: { leftId: A, rightId: B, ratio: 0.5 },
        activeId: active === 'A' ? A : B
      })
      return { X, A, B, Y }
    }

    let t = prepare('A')
    state().closeTab(t.A)
    expect(state().split).toBeNull()
    expect(state().activeId).toBe(t.B)

    t = prepare('B')
    state().closeTab(t.B)
    expect(state().split).toBeNull()
    expect(state().activeId).toBe(t.A)

    t = prepare('A')
    state().closeTab(t.B)
    expect(state().split).toBeNull()
    expect(state().activeId).toBe(t.A)

    t = prepare('A')
    state().closeTab(t.X)
    expect(order()).toEqual([t.A, t.B, t.Y])
    expectVisibleSplit(t.A, t.B, 0.5)
    expect(state().activeId).toBe(t.A)
  })

  it('toggleSplit splits the active tab with its neighbor, then unsplits; one tab does nothing', () => {
    // covers: Test-1055
    const [A, B, C] = fresh(3)
    state().activate(B)
    state().toggleSplit()
    expect(order()).toEqual([A, B, C])
    expectVisibleSplit(B, C, 0.5)
    expect(state().activeId).toBe(B)

    state().toggleSplit()
    expect(state().split).toBeNull()
    expect(state().activeId).toBe(B)

    const [only] = fresh(1)
    state().toggleSplit()
    expect(state().split).toBeNull()
    expect(state().activeId).toBe(only)
  })

  it('goBack, goForward and goUp take a tab id; without one they use the active tab', () => {
    // covers: Test-1056
    const [A, B] = fresh(2)
    const tab = (id: string): Tab => tabs().find((t) => t.id === id)!
    const s = state()
    s.navigate(remote('/t1/sub'), { tabId: B })
    s.navigate(remote('/t0/x'))
    const aBefore = tab(A)

    s.goBack(B)
    expect(tab(B)).toMatchObject({ loc: remote('/t1'), fwd: [remote('/t1/sub')] })
    expect(tab(B).sel).toEqual(['/t1/sub'])
    expect(tab(A)).toBe(aBefore)

    s.goForward(B)
    expect(tab(B)).toMatchObject({ loc: remote('/t1/sub'), back: [remote('/t1')], fwd: [] })
    expect(tab(A)).toBe(aBefore)

    s.goUp(B)
    expect(tab(B)).toMatchObject({ loc: remote('/t1'), sel: ['/t1/sub'], focus: '/t1/sub' })
    expect(tab(A)).toBe(aBefore)
    expect(state().activeId).toBe(A)

    // 인자가 없으면 활성 탭(A).
    s.goBack()
    expect(tab(A).loc).toEqual(remote('/t0'))
    s.goForward()
    expect(tab(A).loc).toEqual(remote('/t0/x'))
    s.goUp()
    expect(tab(A)).toMatchObject({ loc: remote('/t0'), sel: ['/t0/x'] })
    expect(tab(B).loc).toEqual(remote('/t1'))
  })

  it('activating a tab outside the pair shows it alone and keeps the split; a half shows the pair', () => {
    // covers: Test-1057
    const [A, B] = fresh(2)
    const split = { leftId: A, rightId: B, ratio: 0.5 }
    useTabsStore.setState({ split, activeId: A })

    const N = state().openTab(remote('/new'))
    expect(state().activeId).toBe(N)
    expect(visiblePanes(state())).toEqual([{ pane: 'left', tabId: N }])
    expect(state().split).toBe(split)

    state().activate(B)
    expect(visiblePanes(state())).toEqual([
      { pane: 'left', tabId: A },
      { pane: 'right', tabId: B }
    ])
    expect(activePane(state())).toBe('right')
    expect(state().split).toBe(split)

    state().activate(A)
    state().cycleTab(1)
    expect(state().activeId).toBe(B)
    expect(activePane(state())).toBe('right')
    expect(visiblePanes(state())).toHaveLength(2)
    expect(state().split).toBe(split)
  })
})
