import { beforeEach, describe, expect, it } from 'vitest'
import { useTabsStore, type Tab } from './useTabsStore'
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
  useTabsStore.setState({ tabs: [], activeId: '', recent: [] })
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

  it('adoptRemote reuses the active or first remote tab, else opens one, and activates it', () => {
    // covers: Test-785
    const s = useTabsStore.getState()
    const local = active().id

    // No remote tab: a new one.
    s.adoptRemote('me@h:21', '/home')
    expect(tabs()).toHaveLength(2)
    expect(active().loc).toEqual(remote('/home'))
    const r1 = active().id

    // Active tab is local: the first remote tab moves to the new server.
    const r2 = s.openTab(remote('/b'), false)
    s.activate(local)
    s.adoptRemote('you@other:2121', '/start')
    expect(useTabsStore.getState().activeId).toBe(r1)
    expect(active().loc).toEqual(remote('/start', 'you@other:2121'))
    expect(tabs().find((t) => t.id === r2)!.loc).toEqual(remote('/b'))

    // Active tab is remote: that one.
    s.activate(r2)
    s.adoptRemote('me@h:21', '/again')
    expect(useTabsStore.getState().activeId).toBe(r2)
    expect(active().loc).toEqual(remote('/again'))
    expect(tabs()).toHaveLength(3)

    // An agent connect (activate: false) moves the same tab but keeps the active one.
    s.activate(local)
    s.adoptRemote('agent@h:21', '/agent', { activate: false })
    expect(useTabsStore.getState().activeId).toBe(local)
    expect(tabs().find((t) => t.id === r1)!.loc).toEqual(remote('/agent', 'agent@h:21'))
  })
})

describe('useTabsStore — split panes', () => {
  const state = (): ReturnType<typeof useTabsStore.getState> => useTabsStore.getState()
  const paneTabs = (paneId: string): string[] =>
    state()
      .tabs.filter((t) => t.paneId === paneId)
      .map((t) => t.id)

  beforeEach(() => {
    useTabsStore.setState({
      tabs: [],
      activeId: '',
      recent: [],
      panes: [{ id: 'pane1', tabIds: [], activeTabId: '' }]
    })
    useTabsStore.getState().openTab(home)
  })

  it('split() gives each pane its own tab list and its own active tab', () => {
    // covers: Test-918
    const homeId = active().id
    const photosId = useTabsStore.getState().openTab(remote('/photos'), false)
    expect(state().activeId).toBe(homeId)

    const pane2Id = useTabsStore.getState().split('pane1')
    const st = state()
    expect(st.panes.map((p) => p.id)).toEqual(['pane1', pane2Id])
    // M10: 탭은 그대로 두고 소속만 표시한다 — pane1은 두 탭, pane2는 새 탭 하나(M13).
    expect(st.panes[0].tabIds).toEqual([homeId, photosId])
    expect(paneTabs('pane1')).toEqual([homeId, photosId])
    expect(st.panes[1].tabIds).toHaveLength(1)
    expect(paneTabs(pane2Id)).toEqual(st.panes[1].tabIds)
    // M11: 각 패널이 자기 활성 탭을 갖는다. 분할한 쪽이 포커스가 된다.
    const placeholder = st.panes[1].activeTabId
    expect(st.tabs.find((t) => t.id === placeholder)?.paneId).toBe(pane2Id)
    expect(st.activeId).toBe(placeholder)
    expect(st.panes[0].activeTabId).toBe(homeId)

    // 한쪽의 활성 탭을 바꿔도 다른 쪽의 활성 탭은 그대로다.
    useTabsStore.getState().activate(photosId)
    useTabsStore.getState().activate(placeholder)
    const st2 = state()
    expect(st2.panes[0].activeTabId).toBe(photosId)
    expect(st2.panes[1].activeTabId).toBe(placeholder)
    expect(st2.activeId).toBe(placeholder)
  })

  it('closePane() moves the pane’s tabs into the remaining pane so no tab is lost', () => {
    // covers: Test-919
    const homeId = active().id
    const photosId = useTabsStore.getState().openTab(remote('/photos'), false)
    const pane2Id = useTabsStore.getState().split('pane1')
    const placeholder = state().panes[1].activeTabId
    const dstId = state().openTab(remote('/dst'))
    expect(paneTabs(pane2Id)).toEqual([placeholder, dstId])

    state().closePane(pane2Id)
    const st = state()
    // M12: 한 패널로 돌아온다. 탭은 하나도 잃지 않고 남은 패널로 옮겨진다.
    expect(st.panes).toHaveLength(1)
    expect(st.panes[0].id).toBe('pane1')
    expect(st.panes[0].tabIds).toEqual([homeId, photosId, placeholder, dstId])
    expect(st.tabs.map((t) => t.id)).toEqual([homeId, photosId, placeholder, dstId])
    expect(st.tabs.every((t) => t.paneId === 'pane1')).toBe(true)
    // 포커스는 남은 패널의 활성 탭으로 간다.
    expect(st.activeId).toBe(homeId)
  })

  it('keeps the 1↔2 pane invariants: the last pane cannot close and split never makes a third', () => {
    // covers: Test-921
    const homeId = active().id
    // 한 패널일 때: 마지막 패널은 닫히지 않는다(M12).
    state().closePane('pane1')
    expect(state().panes).toHaveLength(1)
    expect(state().tabs.map((t) => t.id)).toEqual([homeId])
    expect(state().activeId).toBe(homeId)

    // split()은 정확히 두 패널을 만든다(M13).
    const pane2Id = state().split('pane1')
    let st = state()
    expect(st.panes).toHaveLength(2)
    expect(st.panes[1].id).toBe(pane2Id)
    expect(st.panes[1].tabIds).toHaveLength(1)
    expect(st.tabs).toHaveLength(2)

    // 이미 두 패널이면 셋째 패널을 만들지 않는다(M10).
    state().split(pane2Id)
    st = state()
    expect(st.panes).toHaveLength(2)
    expect(st.tabs).toHaveLength(2)

    // 한 패널로 돌아온 뒤에도 마지막 패널은 닫히지 않는다.
    state().closePane('pane1')
    st = state()
    expect(st.panes).toHaveLength(1)
    expect(st.panes[0].id).toBe(pane2Id)
    expect(st.tabs).toHaveLength(2)
    expect(st.tabs.every((t) => t.paneId === pane2Id)).toBe(true)
    const focused = st.activeId
    state().closePane(pane2Id)
    expect(state().panes).toHaveLength(1)
    expect(state().activeId).toBe(focused)
  })
})
