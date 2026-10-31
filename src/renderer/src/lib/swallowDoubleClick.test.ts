/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { SWALLOW_WAIT_MS, swallowRestOfDoubleClick } from './swallowDoubleClick'

const AT = { clientX: 100, clientY: 40 }
let el: HTMLElement
let reached: string[]

beforeEach(() => {
  vi.useFakeTimers()
  el = document.createElement('div')
  reached = []
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick'])
    el.addEventListener(type, (e) => reached.push(`${type}${(e as MouseEvent).detail || ''}`))
  document.body.append(el)
})

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

/** Chromium이 보내는 한 번의 누름: pointerdown, mousedown, pointerup, mouseup, click(+dblclick). */
function press(detail: number, init: Partial<MouseEventInit> = {}): { focusKept: boolean } {
  const at = { ...AT, button: 0, ...init }
  fireEvent.pointerDown(el, at)
  const focusKept = !fireEvent.mouseDown(el, { ...at, detail })
  fireEvent.pointerUp(el, at)
  fireEvent.mouseUp(el, { ...at, detail })
  fireEvent.click(el, { ...at, detail })
  if (detail === 2) fireEvent.dblClick(el, { ...at, detail })
  return { focusKept }
}

describe('swallowRestOfDoubleClick', () => {
  it('swallows the second and third press near the first click, even a slow one', () => {
    // covers: Test-1397
    swallowRestOfDoubleClick({ x: 100, y: 40 })
    vi.advanceTimersByTime(SWALLOW_WAIT_MS - 1)

    expect(press(2, { clientX: 108, clientY: 32 }).focusKept).toBe(true)
    expect(press(3).focusKept).toBe(true)
    expect(reached).toEqual([])
  })

  it('stops at a new click, and when no press comes in time', () => {
    // covers: Test-1397
    swallowRestOfDoubleClick({ x: 100, y: 40 })
    expect(press(1).focusKept).toBe(false)
    // 근처의 새 누름은 pointerdown만 놓친다: mousedown부터는 닿아 드래그·포커스가 그대로다
    expect(reached).toEqual(['mousedown1', 'pointerup', 'mouseup1', 'click1'])
    reached = []
    expect(press(2).focusKept).toBe(false)
    expect(reached).toContain('dblclick2')

    swallowRestOfDoubleClick({ x: 100, y: 40 })
    vi.advanceTimersByTime(SWALLOW_WAIT_MS)
    reached = []
    expect(press(2).focusKept).toBe(false)
    expect(reached[0]).toBe('pointerdown')
  })

  it('lets a press away from the first click and other buttons through', () => {
    // covers: Test-1397
    swallowRestOfDoubleClick({ x: 100, y: 40 })

    fireEvent.pointerDown(el, { ...AT, clientX: 109, button: 0 })
    // 뒤로 가기 버튼(3)은 삼키지도, 끝내지도 않는다
    fireEvent.pointerDown(el, { ...AT, button: 3 })
    fireEvent.mouseDown(el, { ...AT, button: 3, detail: 1 })
    fireEvent.mouseUp(el, { ...AT, button: 3, detail: 1 })
    expect(reached).toEqual(['pointerdown', 'pointerdown', 'mousedown1', 'mouseup1'])

    reached = []
    expect(press(2).focusKept).toBe(true)
    expect(reached).toEqual([])
  })
})
