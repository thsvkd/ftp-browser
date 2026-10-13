import { describe, expect, it } from 'vitest'
import {
  clearSelection,
  clickSelect,
  moveFocus,
  navIndex,
  selectAll,
  selectMany,
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
    expect(toggleSelect(one, 'b')).toEqual({ sel: [], anchor: 'b', focus: null })
    expect(toggleSelect(one, 'c')).toEqual({ sel: ['b', 'c'], anchor: 'c', focus: 'c' })
  })
})

// ---------- 선택 = 포커스(explorer-menu-and-focus F1·F3·F6·F10) ----------

const st = (sel: string[], anchor: string | null, focus: string | null): SelectionState => ({
  sel,
  anchor,
  focus
})
const PLAIN = { shift: false, ctrl: false }
const SHIFT = { shift: true, ctrl: false }
const CTRL = { shift: false, ctrl: true }
const CTRL_SHIFT = { shift: true, ctrl: true }

describe('selectionModel — selection is the focus', () => {
  it('moves the selection with keys, Ctrl alone like a plain move, Ctrl+Shift adds a range', () => {
    // covers: Test-852
    const c = moveFocus(none, paths, 2, PLAIN)
    expect(c).toEqual(st(['c'], 'c', 'c'))
    expect(moveFocus(c, paths, 4, SHIFT)).toEqual(st(['c', 'd', 'e'], 'c', 'e'))
    expect(moveFocus(c, paths, 0, SHIFT)).toEqual(st(['a', 'b', 'c'], 'c', 'a'))
    expect(moveFocus(c, paths, 5, CTRL)).toEqual(st(['f'], 'f', 'f'))
    expect(moveFocus(st(['a', 'b'], 'b', 'b'), paths, 4, CTRL_SHIFT)).toEqual(
      st(['a', 'b', 'c', 'd', 'e'], 'b', 'e')
    )
    expect(moveFocus(none, paths, 3, SHIFT)).toEqual(st(['d'], 'd', 'd'))
  })

  it('moves the focus to the last remaining item when a toggle removes the focused one', () => {
    // covers: Test-853
    const b = st(['b'], 'b', 'b')
    const bc = toggleSelect(b, 'c')
    expect(bc).toEqual(st(['b', 'c'], 'c', 'c'))
    expect(toggleSelect(bc, 'c')).toEqual(st(['b'], 'c', 'b'))
    expect(toggleSelect(b, 'b')).toEqual(st([], 'b', null))
    expect(toggleSelect(st(['b', 'c', 'd'], 'd', 'd'), 'b')).toEqual(st(['c', 'd'], 'b', 'd'))
  })

  it('clears everything and selects many with the last one focused', () => {
    // covers: Test-854
    expect(clearSelection()).toEqual(st([], null, null))
    for (const s of [none, st(['a'], 'a', 'a'), st(['b', 'c'], 'x', 'c')])
      expect(selectMany(s, [])).toEqual(clearSelection())
    expect(selectMany(st(['a'], 'a', 'a'), ['a', 'b', 'c'])).toEqual(st(['a', 'b', 'c'], 'a', 'c'))
    expect(selectMany(st(['x'], 'x', 'x'), ['d', 'e'])).toEqual(st(['d', 'e'], 'd', 'e'))
    const input = ['a', 'b', 'a']
    expect(selectMany(none, input).sel).toEqual(['a', 'b'])
    expect(input).toEqual(['a', 'b', 'a'])
  })

  it('keeps the invariants under every sequence of up to three operations', () => {
    // covers: Test-855
    type Op = (s: SelectionState, p: string) => SelectionState
    const i = (p: string): number => paths.indexOf(p)
    const ops: Record<string, Op> = {
      click: (s, p) =>
        clickSelect(s, paths, p, { shiftKey: false, ctrlKey: false, metaKey: false }, 'win32'),
      shiftClick: (s, p) =>
        clickSelect(s, paths, p, { shiftKey: true, ctrlKey: false, metaKey: false }, 'win32'),
      toggleClick: (s, p) =>
        clickSelect(s, paths, p, { shiftKey: false, ctrlKey: true, metaKey: false }, 'win32'),
      move: (s, p) => moveFocus(s, paths, i(p), PLAIN),
      moveShift: (s, p) => moveFocus(s, paths, i(p), SHIFT),
      moveCtrl: (s, p) => moveFocus(s, paths, i(p), CTRL),
      moveCtrlShift: (s, p) => moveFocus(s, paths, i(p), CTRL_SHIFT),
      toggle: (s, p) => toggleSelect(s, p),
      selectSome: (s, p) => selectMany(s, paths.slice(i(p), i(p) + 3)),
      selectNone: (s) => selectMany(s, []),
      selectAll: (s) => selectAll(s, paths),
      selectAllHidingFocus: (s, p) =>
        selectAll(
          s,
          paths.filter((x) => x !== s.focus && x !== p)
        ),
      clear: () => clearSelection()
    }
    const names = Object.keys(ops)
    let checked = 0
    let n = 0
    const walk = (s: SelectionState, depth: number, trail: string[]): void => {
      if (depth === 3) return
      for (const name of names) {
        const target = paths[(n++ * 7 + depth) % paths.length]
        const next = ops[name](s, target)
        const where = [...trail, `${name}(${target})`].join(' → ')
        expect(next.focus === null || next.sel.includes(next.focus), `I1: ${where}`).toBe(true)
        expect(next.sel.length > 0 || next.focus === null, `I2: ${where}`).toBe(true)
        expect(new Set(next.sel).size, `no duplicates: ${where}`).toBe(next.sel.length)
        expect(
          next.sel.every((x) => paths.includes(x)),
          `only known paths: ${where}`
        ).toBe(true)
        checked++
        walk(next, depth + 1, [...trail, `${name}(${target})`])
      }
    }
    walk(clearSelection(), 0, [])
    expect(checked).toBe(13 + 13 ** 2 + 13 ** 3)
  })

  it('starts a Shift or toggle click from a cleared selection without a stale anchor', () => {
    // covers: Test-868
    const shift = { shiftKey: true, ctrlKey: false, metaKey: false }
    const d = clickSelect(clearSelection(), paths, 'd', shift, 'win32')
    expect(d).toEqual(st(['d'], 'd', 'd'))
    expect(clickSelect(d, paths, 'f', shift, 'win32')).toEqual(st(['d', 'e', 'f'], 'd', 'f'))
    expect(
      clickSelect(
        clearSelection(),
        paths,
        'c',
        { shiftKey: false, ctrlKey: true, metaKey: false },
        'win32'
      )
    ).toEqual(st(['c'], 'c', 'c'))
    expect(clearSelection().anchor).toBeNull()
  })

  it('selects all visible paths and drops a focus that is not among them', () => {
    // covers: Test-869
    expect(selectAll(st(['b'], 'b', 'b'), ['a', 'b', 'c', 'd', 'e'])).toEqual(
      st(['a', 'b', 'c', 'd', 'e'], 'b', 'b')
    )
    expect(selectAll(st(['x'], 'x', 'x'), ['a', 'b'])).toEqual(st(['a', 'b'], 'x', null))
    expect(selectAll(st(['a'], 'a', null), ['a', 'b'])).toEqual(st(['a', 'b'], 'a', null))
    for (const s of [none, st(['a'], 'a', 'a'), st(['x'], 'x', 'x')])
      expect(selectAll(s, [])).toEqual(st([], null, null))
    const input = ['a', 'b', 'a']
    expect(selectAll(none, input).sel).toEqual(['a', 'b'])
    expect(input).toEqual(['a', 'b', 'a'])
  })
})
