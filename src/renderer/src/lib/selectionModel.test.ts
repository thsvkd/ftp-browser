import { describe, expect, it } from 'vitest'
import {
  clickSelect,
  moveFocus,
  navIndex,
  toggleSelect,
  type SelectionState
} from './selectionModel'

const paths = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
const none: SelectionState = { sel: [], anchor: null, focus: null }

describe('selectionModel keyboard', () => {
  it('moves the focus by grid columns and pages, clamps, and selects per modifier', () => {
    // covers: Test-775
    // 10 items in 4 columns, 2 rows per page.
    const at = (key: string, focus: number): number | null => navIndex(key, focus, 10, 4, 2)
    expect(at('ArrowDown', 1)).toBe(5)
    expect(at('ArrowUp', 5)).toBe(1)
    expect(at('ArrowRight', 1)).toBe(2)
    expect(at('ArrowLeft', 1)).toBe(0)
    expect(at('Home', 6)).toBe(0)
    expect(at('End', 2)).toBe(9)
    expect(at('PageDown', 0)).toBe(8)
    expect(at('PageUp', 9)).toBe(1)
    // Clamped to the ends.
    expect(at('ArrowUp', 1)).toBe(0)
    expect(at('ArrowDown', 8)).toBe(9)
    expect(at('ArrowLeft', 0)).toBe(0)
    expect(at('PageDown', 7)).toBe(9)
    // No focus yet: the first move lands on the first item.
    expect(at('ArrowDown', -1)).toBe(0)
    expect(at('End', -1)).toBe(9)
    expect(at('Enter', 3)).toBeNull()
    expect(navIndex('ArrowDown', -1, 0, 4, 2)).toBeNull()

    // Plain move = single selection with the anchor on it.
    const plain = moveFocus(none, paths, 2, { shift: false, ctrl: false })
    expect(plain).toEqual({ sel: ['c'], anchor: 'c', focus: 'c' })
    // Shift = range from the anchor.
    expect(moveFocus(plain, paths, 4, { shift: true, ctrl: false })).toEqual({
      sel: ['c', 'd', 'e'],
      anchor: 'c',
      focus: 'e'
    })
    expect(moveFocus(plain, paths, 0, { shift: true, ctrl: false }).sel).toEqual(['a', 'b', 'c'])
    // Ctrl = focus only.
    expect(moveFocus(plain, paths, 5, { shift: false, ctrl: true })).toEqual({
      sel: ['c'],
      anchor: 'c',
      focus: 'f'
    })
  })
})

describe('selectionModel pointer', () => {
  it('selects on click by modifier and platform, and toggles with Ctrl+Space', () => {
    // covers: Test-776
    const plain = { shiftKey: false, ctrlKey: false, metaKey: false }
    const one = clickSelect(none, paths, 'b', plain, 'win32')
    expect(one).toEqual({ sel: ['b'], anchor: 'b', focus: 'b' })

    expect(clickSelect(one, paths, 'd', { ...plain, shiftKey: true }, 'win32')).toEqual({
      sel: ['b', 'c', 'd'],
      anchor: 'b',
      focus: 'd'
    })

    // Windows: Ctrl toggles.
    const added = clickSelect(one, paths, 'e', { ...plain, ctrlKey: true }, 'win32')
    expect(added).toEqual({ sel: ['b', 'e'], anchor: 'e', focus: 'e' })
    expect(clickSelect(added, paths, 'b', { ...plain, ctrlKey: true }, 'win32').sel).toEqual(['e'])

    // macOS: Cmd toggles, Ctrl (secondary click) is a plain click.
    expect(clickSelect(one, paths, 'e', { ...plain, metaKey: true }, 'darwin').sel).toEqual([
      'b',
      'e'
    ])
    expect(clickSelect(one, paths, 'e', { ...plain, ctrlKey: true }, 'darwin').sel).toEqual(['e'])

    // Ctrl+Space toggles the focused item.
    expect(toggleSelect(one, 'b')).toEqual({ sel: [], anchor: 'b', focus: 'b' })
    expect(toggleSelect(one, 'c')).toEqual({ sel: ['b', 'c'], anchor: 'c', focus: 'c' })
  })
})
