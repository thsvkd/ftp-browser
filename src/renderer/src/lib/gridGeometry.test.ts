import { describe, it, expect } from 'vitest'
import { itemIndicesInRect, type GridRect } from './gridGeometry'

// Layout used across these tests: 3 columns, 100px cells, 10px gap, 8px left pad.
//   col x ranges: 0 -> 8..108, 1 -> 118..218, 2 -> 228..328
//   row y ranges: 0 -> 0..100, 1 -> 110..210, 2 -> 220..320
const COLS = 3
const CELL = 100
const GAP = 10
const PAD = 8

function rect(left: number, top: number, right: number, bottom: number): GridRect {
  return { left, top, right, bottom }
}

describe('itemIndicesInRect', () => {
  it('selects a single cell the rect overlaps', () => {
    expect(itemIndicesInRect(rect(20, 20, 40, 40), 9, COLS, CELL, GAP, PAD, 0)).toEqual([0])
  })

  it('selects multiple cells across columns in the same row', () => {
    // Spans col 0 and col 1 on row 0.
    expect(itemIndicesInRect(rect(50, 10, 150, 50), 9, COLS, CELL, GAP, PAD, 0)).toEqual([0, 1])
  })

  it('selects a full block across rows and columns', () => {
    // Covers all of rows 0-1, cols 0-1 => items 0,1,3,4.
    expect(itemIndicesInRect(rect(0, 0, 220, 210), 9, COLS, CELL, GAP, PAD, 0)).toEqual([
      0, 1, 3, 4
    ])
  })

  it('selects nothing when the rect sits entirely in a gap', () => {
    // Horizontal gap between col 0 (..108) and col 1 (118..) is 108..118.
    expect(itemIndicesInRect(rect(109, 10, 117, 90), 9, COLS, CELL, GAP, PAD, 0)).toEqual([])
  })

  it('selects nothing in the vertical gap between rows', () => {
    // Vertical gap between row 0 (..100) and row 1 (110..) is 100..110.
    expect(itemIndicesInRect(rect(10, 101, 90, 109), 9, COLS, CELL, GAP, PAD, 0)).toEqual([])
  })

  it('accounts for a leading parent-cell offset', () => {
    // offset=1 pushes item 0 into layout slot 1 (col 1), item 2 into slot 3 (row 1, col 0).
    expect(itemIndicesInRect(rect(118, 0, 218, 100), 9, COLS, CELL, GAP, PAD, 1)).toEqual([0])
    expect(itemIndicesInRect(rect(8, 110, 108, 210), 9, COLS, CELL, GAP, PAD, 1)).toEqual([2])
  })

  it('returns an empty array for an empty grid or zero columns', () => {
    expect(itemIndicesInRect(rect(0, 0, 999, 999), 0, COLS, CELL, GAP, PAD, 0)).toEqual([])
    expect(itemIndicesInRect(rect(0, 0, 999, 999), 9, 0, CELL, GAP, PAD, 0)).toEqual([])
  })
})
