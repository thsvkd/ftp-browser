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
  useShelfStore.setState({ items: [], railTab: 'info' })
})

describe('useShelfStore', () => {
  it('adds without duplicates by side+server+path, switches the rail, removes and clears', () => {
    // covers: Test-786
    const s = useShelfStore.getState()
    const a = entry('remote', '/a', 'me@h:21')
    const sameOnOther = entry('remote', '/a', 'you@h:21')
    const sameLocal = entry('local', '/a')

    expect(s.add([a, sameOnOther])).toBe(2)
    expect(useShelfStore.getState().railTab).toBe('shelf')

    useShelfStore.setState({ railTab: 'info' })
    expect(s.add([a])).toBe(0)
    // Nothing new: the rail stays where it was.
    expect(useShelfStore.getState().railTab).toBe('info')

    expect(s.add([sameLocal, a, sameLocal])).toBe(1)
    expect(useShelfStore.getState().items.map((i) => i.entry)).toEqual([a, sameOnOther, sameLocal])

    s.remove([locKey(sameOnOther)])
    expect(useShelfStore.getState().items.map((i) => i.entry)).toEqual([a, sameLocal])

    s.clear()
    expect(useShelfStore.getState().items).toEqual([])
  })
})
