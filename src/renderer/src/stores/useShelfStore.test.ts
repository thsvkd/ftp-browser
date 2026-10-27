import { beforeEach, describe, expect, it } from 'vitest'
import { useShelfStore } from './useShelfStore'
import { locKey, type ExplorerEntry } from '@renderer/lib/explorerEntry'

function entry(side: ExplorerEntry['side'], path: string, server?: string): ExplorerEntry {
  return {
    side,
    ...(server ? { server } : {}),
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    type: 'file',
    size: 1,
    modifiedAt: '',
    hidden: false,
    category: 'other',
    isImage: false
  }
}

beforeEach(() => {
  useShelfStore.setState({ items: [], dockOpen: false })
})

describe('useShelfStore', () => {
  it('adds without duplicates by side+server+path, removes and clears', () => {
    // covers: Test-786
    const s = useShelfStore.getState()
    const a = entry('remote', '/a', 'me@h:21')
    const sameOnOther = entry('remote', '/a', 'you@h:21')
    const sameLocal = entry('local', '/a')

    expect(s.add([a, sameOnOther])).toBe(2)

    useShelfStore.setState({ dockOpen: false })
    expect(s.add([a])).toBe(0)
    // Nothing new: the dock stays where it was.
    expect(useShelfStore.getState().dockOpen).toBe(false)

    expect(s.add([sameLocal, a, sameLocal])).toBe(1)
    expect(useShelfStore.getState().items.map((i) => i.entry)).toEqual([a, sameOnOther, sameLocal])

    s.remove([locKey(sameOnOther)])
    expect(useShelfStore.getState().items.map((i) => i.entry)).toEqual([a, sameLocal])

    s.clear()
    expect(useShelfStore.getState().items).toEqual([])
  })

  it('leaves the dock as it was when items are added', () => {
    // covers: Test-1316
    useShelfStore.setState({ dockOpen: false })
    expect(useShelfStore.getState().add([entry('local', '/a')])).toBe(1)
    expect(useShelfStore.getState().dockOpen).toBe(false)

    useShelfStore.setState({ dockOpen: true })
    expect(useShelfStore.getState().add([entry('local', '/b')])).toBe(1)
    expect(useShelfStore.getState().dockOpen).toBe(true)
  })

  it('toggles and sets the dock open, and keeps dockOpen when the shelf is cleared', () => {
    // covers: Test-1246
    useShelfStore.getState().setDockOpen(true)
    expect(useShelfStore.getState().dockOpen).toBe(true)
    useShelfStore.getState().toggleDock()
    expect(useShelfStore.getState().dockOpen).toBe(false)
    useShelfStore.getState().toggleDock()
    expect(useShelfStore.getState().dockOpen).toBe(true)

    useShelfStore.getState().add([entry('local', '/a')])
    useShelfStore.getState().clear()
    expect(useShelfStore.getState().items).toEqual([])
    expect(useShelfStore.getState().dockOpen).toBe(true)
  })
})
