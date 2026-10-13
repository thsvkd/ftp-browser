import { describe, expect, it } from 'vitest'
import { SPLIT_CHIP_H_PX, SPLIT_CHIP_INSET_PX, TAB_GHOST_HALF_H } from './explorerLayout'
import {
  chipSlot,
  clampRatio,
  dragModeFor,
  insertionIndex,
  overlayRect,
  splitPartner,
  zoneFromPoint,
  type Rect
} from './splitLayout'

describe('zoneFromPoint', () => {
  const rect: Rect = { left: 100, top: 50, width: 1000, height: 600 }

  it('splits the content into left 33% / center 34% / right 33%, edges inside', () => {
    // covers: Test-1040
    expect(zoneFromPoint(rect, 100, 300)).toBe('left')
    expect(zoneFromPoint(rect, 429, 300)).toBe('left')
    expect(zoneFromPoint(rect, 430, 300)).toBe('center')
    expect(zoneFromPoint(rect, 600, 300)).toBe('center')
    expect(zoneFromPoint(rect, 770, 300)).toBe('center')
    expect(zoneFromPoint(rect, 771, 300)).toBe('right')
    expect(zoneFromPoint(rect, 1100, 300)).toBe('right')
  })

  it('returns null outside the rect or for an empty rect', () => {
    // covers: Test-1041
    expect(zoneFromPoint(rect, 99, 300)).toBeNull()
    expect(zoneFromPoint(rect, 1101, 300)).toBeNull()
    expect(zoneFromPoint(rect, 600, 49)).toBeNull()
    expect(zoneFromPoint(rect, 600, 651)).toBeNull()
    expect(zoneFromPoint({ ...rect, width: 0 }, 100, 300)).toBeNull()
    expect(zoneFromPoint({ ...rect, height: 0 }, 600, 50)).toBeNull()
  })
})

describe('overlayRect', () => {
  it('paints the half without a split, else the pane drawn at the clamped ratio', () => {
    // covers: Test-1042
    const R: Rect = { left: 0, top: 48, width: 1000, height: 600 }
    const box = (left: number, width: number): Rect => ({ left, top: 48, width, height: 600 })
    expect(overlayRect(R, 'left', null)).toEqual(box(0, 500))
    expect(overlayRect(R, 'right', null)).toEqual(box(500, 500))
    expect(overlayRect(R, 'left', 0.4)).toEqual(box(0, 400))
    expect(overlayRect(R, 'right', 0.4)).toEqual(box(400, 600))
    expect(overlayRect(R, 'left', 0.1)).toEqual(box(0, 280))
    expect(overlayRect(R, 'right', 0.1)).toEqual(box(280, 720))

    const shifted: Rect = { ...R, left: 100 }
    expect(overlayRect(shifted, 'left', null)).toEqual(box(100, 500))
    expect(overlayRect(shifted, 'right', null)).toEqual(box(600, 500))
    expect(overlayRect(shifted, 'left', 0.4)).toEqual(box(100, 400))
    expect(overlayRect(shifted, 'right', 0.4)).toEqual(box(500, 600))
    expect(overlayRect(shifted, 'left', 0.1)).toEqual(box(100, 280))
    expect(overlayRect(shifted, 'right', 0.1)).toEqual(box(380, 720))
  })
})

describe('dragModeFor', () => {
  it('enters split only below the strip + 16 and returns to reorder only above the strip', () => {
    // covers: Test-1043
    expect(dragModeFor('reorder', 116, 100)).toBe('reorder')
    expect(dragModeFor('reorder', 116.5, 100)).toBe('split')
    expect(dragModeFor('split', 100, 100)).toBe('split')
    expect(dragModeFor('split', 110, 100)).toBe('split')
    expect(dragModeFor('split', 99.5, 100)).toBe('reorder')
    expect(dragModeFor('reorder', 50, 100)).toBe('reorder')
  })
})

describe('clampRatio', () => {
  it('keeps each pane at least 280px, and fixes 50:50 when both cannot be', () => {
    // covers: Test-1044
    expect(clampRatio(0.1, 1000)).toBe(0.28)
    expect(clampRatio(0.9, 1000)).toBe(0.72)
    expect(clampRatio(0.5, 1000)).toBe(0.5)
    expect(clampRatio(0.4, 1000)).toBe(0.4)
    for (const width of [560, 400])
      for (const ratio of [0, 0.1, 0.3, 0.5, 0.7, 1]) expect(clampRatio(ratio, width)).toBe(0.5)
    expect(clampRatio(0.15, 1400)).toBe(0.2)
  })
})

describe('insertionIndex', () => {
  it('counts the unit centers left of x', () => {
    // covers: Test-1045
    const mids = [50, 150, 250]
    expect(insertionIndex(mids, 10)).toBe(0)
    expect(insertionIndex(mids, 100)).toBe(1)
    expect(insertionIndex(mids, 150)).toBe(1)
    expect(insertionIndex(mids, 151)).toBe(2)
    expect(insertionIndex(mids, 300)).toBe(3)
    expect(insertionIndex([], 100)).toBe(0)
  })
})

describe('splitPartner', () => {
  it('pairs with the active tab, or the neighbor (next, else previous) when dragging the active tab', () => {
    // covers: Test-1046
    const order = ['a', 'b', 'c']
    expect(splitPartner(order, 'b', 'c')).toBe('b')
    expect(splitPartner(order, 'b', 'b')).toBe('c')
    expect(splitPartner(order, 'c', 'c')).toBe('b')
    expect(splitPartner(order, 'a', 'a')).toBe('b')
    expect(splitPartner(['a'], 'a', 'a')).toBeNull()
  })
})

describe('chipSlot', () => {
  it('puts the overlay chips at the vertical end away from the pointer so the drag ghost never covers them', () => {
    // covers: Test-1170
    const rect: Rect = { left: 0, top: 100, width: 800, height: 400 }
    expect(chipSlot(rect, 299)).toBe('bottom')
    expect(chipSlot(rect, 300)).toBe('top')
    expect(chipSlot(rect, 100)).toBe('bottom')
    expect(chipSlot(rect, 500)).toBe('top')

    for (const height of [148, 149, 400]) {
      const r: Rect = { left: 0, top: 100, width: 800, height }
      for (let y = r.top; y <= r.top + r.height; y++) {
        const ghost = [y - TAB_GHOST_HALF_H, y + TAB_GHOST_HALF_H]
        const chip =
          chipSlot(r, y) === 'top'
            ? [r.top + SPLIT_CHIP_INSET_PX, r.top + SPLIT_CHIP_INSET_PX + SPLIT_CHIP_H_PX]
            : [
                r.top + r.height - SPLIT_CHIP_INSET_PX - SPLIT_CHIP_H_PX,
                r.top + r.height - SPLIT_CHIP_INSET_PX
              ]
        // 끝점이 닿는 것은 겹침이 아니다.
        const overlap = ghost[0] < chip[1] && chip[0] < ghost[1]
        expect(overlap, `height ${height}, y ${y}`).toBe(false)
      }
    }
  })
})
