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
