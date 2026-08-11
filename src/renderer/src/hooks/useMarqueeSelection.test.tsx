/** @vitest-environment jsdom */
import { useRef } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { makeApiMock, type ApiMock } from '@renderer/test/rendererTestUtils'
import { useMarqueeSelection } from './useMarqueeSelection'

/** 드래그 사각형에 걸리는 항목. */
const HIT_NAMES = ['b.txt']
/** 드래그 시작 시점의 기존 선택. */
const EXISTING_SELECTION = ['a.txt']

const setSelection = vi.fn()
let apiMock: ApiMock

function Harness(): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { onMouseDown } = useMarqueeSelection({
    scrollRef,
    namesInRect: () => HIT_NAMES,
    setSelection,
    getSelection: () => new Set(EXISTING_SELECTION)
  })
  return <div ref={scrollRef} data-testid="grid" onMouseDown={onMouseDown} />
}

/**
 * 빈 공간에서 시작하는 마퀴 드래그 한 번. 이동 리스너는 window에 붙으므로
 * mousemove/mouseup도 window로 쏜다.
 */
function drag(modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): void {
  fireEvent.mouseDown(screen.getByTestId('grid'), {
    button: 0,
    clientX: 0,
    clientY: 0,
    ...modifiers
  })
  fireEvent.mouseMove(window, { clientX: 40, clientY: 40 })
  fireEvent.mouseUp(window)
}

/** 드래그가 최종적으로 확정한 선택. */
function finalSelection(): string[] {
  const calls = setSelection.mock.calls
  if (calls.length === 0) throw new Error('setSelection was never called')
  return [...(calls[calls.length - 1][0] as string[])].sort()
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMock = makeApiMock(vi.fn())
  vi.stubGlobal('api', apiMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// E그룹. useMarqueeSelection의 additive 판정도 뷰의 클릭 핸들러와 같은 규칙을 따라야 한다(D7).
describe('useMarqueeSelection — additive modifiers', () => {
  it('should replace the selection when Ctrl is held on macOS', () => {
    // covers: Test-156
    apiMock.platform = 'darwin'
    render(<Harness />)

    drag({ ctrlKey: true })

    // additive가 아니면 기존 선택은 mousedown 시점에 비워지고 결과가 대체된다.
    expect(setSelection).toHaveBeenCalledWith([])
    expect(finalSelection()).toEqual(HIT_NAMES)
  })

  it('should add to the selection when Cmd is held on macOS', () => {
    // covers: Test-157
    apiMock.platform = 'darwin'
    render(<Harness />)

    drag({ metaKey: true })

    expect(setSelection).not.toHaveBeenCalledWith([])
    expect(finalSelection()).toEqual([...EXISTING_SELECTION, ...HIT_NAMES].sort())
  })

  it('should add to the selection when Shift is held on either platform', () => {
    // covers: Test-158
    for (const platform of ['darwin', 'win32']) {
      apiMock.platform = platform
      render(<Harness />)

      drag({ shiftKey: true })

      expect(setSelection, platform).not.toHaveBeenCalledWith([])
      expect(finalSelection(), platform).toEqual([...EXISTING_SELECTION, ...HIT_NAMES].sort())

      cleanup()
      setSelection.mockClear()
    }
  })
})
