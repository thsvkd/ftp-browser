/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { swallowRestOfDoubleClick } from './swallowDoubleClick'

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

function target(): { el: HTMLElement; reached: ReturnType<typeof vi.fn> } {
  const el = document.createElement('div')
  const reached = vi.fn()
  for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick'])
    el.addEventListener(type, reached)
  document.body.append(el)
  return { el, reached }
}

describe('swallowRestOfDoubleClick', () => {
  it('lets a press away from the first click through, and stops after the double-click', () => {
    // covers: Test-1397
    const { el, reached } = target()
    swallowRestOfDoubleClick({ x: 100, y: 40 })

    fireEvent.pointerDown(el, { clientX: 200, clientY: 40 })
    expect(reached).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(el, { clientX: 105, clientY: 45 })
    fireEvent.mouseDown(el, { detail: 2 })
    fireEvent.dblClick(el, { detail: 2 })
    expect(reached).toHaveBeenCalledTimes(1)

    // 더블클릭이 끝나면 그만둔다
    fireEvent.pointerDown(el, { clientX: 100, clientY: 40 })
    fireEvent.mouseDown(el, { detail: 2 })
    expect(reached).toHaveBeenCalledTimes(3)
  })

  it('stops when no second press comes in time', () => {
    // covers: Test-1397
    vi.useFakeTimers()
    const { el, reached } = target()
    swallowRestOfDoubleClick({ x: 100, y: 40 })

    vi.advanceTimersByTime(600)
    fireEvent.pointerDown(el, { clientX: 100, clientY: 40 })
    fireEvent.mouseDown(el, { detail: 2 })
    expect(reached).toHaveBeenCalledTimes(2)
  })
})
