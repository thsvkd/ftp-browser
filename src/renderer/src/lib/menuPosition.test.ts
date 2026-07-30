import { describe, it, expect } from 'vitest'
import { clampMenuPosition } from './menuPosition'

// 핸드오프 6절 A표의 리터럴 기댓값을 그대로 단언한다. MENU_VIEWPORT_MARGIN을 import해
// 계산식으로 기댓값을 만들면 상수를 함께 바꿨을 때 통과해버리는 자기참조가 된다.
describe('clampMenuPosition', () => {
  it('keeps the anchor as-is when the menu fully fits', () => {
    // covers: Test-96
    expect(
      clampMenuPosition({ x: 10, y: 10 }, { width: 160, height: 200 }, { width: 1000, height: 800 })
    ).toEqual({
      left: 10,
      top: 10
    })
  })

  it('flips upward when the menu overflows the bottom edge', () => {
    // covers: Test-97
    expect(
      clampMenuPosition(
        { x: 10, y: 700 },
        { width: 160, height: 200 },
        { width: 1000, height: 800 }
      )
    ).toEqual({ left: 10, top: 500 })
  })

  it('flips to the left when the menu overflows the right edge', () => {
    // covers: Test-98
    expect(
      clampMenuPosition(
        { x: 900, y: 10 },
        { width: 160, height: 200 },
        { width: 1000, height: 800 }
      )
    ).toEqual({ left: 740, top: 10 })
  })

  it('flips both axes when the menu overflows the bottom and right edges', () => {
    // covers: Test-99
    expect(
      clampMenuPosition(
        { x: 900, y: 700 },
        { width: 160, height: 200 },
        { width: 1000, height: 800 }
      )
    ).toEqual({ left: 740, top: 500 })
  })

  it('clamps to the top margin when flipping still overflows the top edge', () => {
    // covers: Test-100
    const result = clampMenuPosition(
      { x: 150, y: 150 },
      { width: 160, height: 200 },
      { width: 1000, height: 300 }
    )
    expect(result.top).toBe(4)
  })

  it('clamps to the left margin when flipping still overflows the left edge', () => {
    // covers: Test-101
    const result = clampMenuPosition(
      { x: 100, y: 10 },
      { width: 160, height: 200 },
      { width: 200, height: 800 }
    )
    expect(result.left).toBe(4)
  })

  it('clamps to the top margin when the menu is taller than the viewport', () => {
    // covers: Test-102
    const result = clampMenuPosition(
      { x: 10, y: 100 },
      { width: 160, height: 1000 },
      { width: 1000, height: 800 }
    )
    expect(result.top).toBe(4)
  })

  it('does not flip when the menu exactly touches the bottom margin', () => {
    // covers: Test-103
    // Test-103이 경계 부등호를 `>=`로 잘못 쓴 구현을 잡는다.
    const result = clampMenuPosition(
      { x: 10, y: 596 },
      { width: 160, height: 200 },
      { width: 1000, height: 800 }
    )
    expect(result.top).toBe(596)
  })
})
