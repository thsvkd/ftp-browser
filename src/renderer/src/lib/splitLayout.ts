// 분할 보기(split-view.md §3.3)의 순수 계산: 존 히트 테스트, 오버레이 영역, 드래그 모드, 비율, 순서 변경 위치, 짝.
import { PANE_MIN_PX, SPLIT_EDGE, SPLIT_ENTER_PX } from './explorerLayout'

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}
export type Zone = 'left' | 'center' | 'right'

/**
 * 콘텐츠 영역의 존(F5·F8): 왼쪽 33% · 가운데 34% · 오른쪽 33%(경계값은 가운데). rect 밖이거나
 * 폭·높이가 0 이하면 null. 테두리는 안쪽이다. 비율 대신 px로 비교해 0.67 같은 경계가 부동소수에 밀리지 않는다.
 */
export function zoneFromPoint(rect: Rect, x: number, y: number): Zone | null {
  const { left, top, width, height } = rect
  if (width <= 0 || height <= 0) return null
  if (x < left || x > left + width || y < top || y > top + height) return null
  const edge = SPLIT_EDGE * width
  if (x - left < edge) return 'left'
  if (left + width - x < edge) return 'right'
  return 'center'
}

/**
 * 오버레이가 칠할 영역(F6·Q5, 안쪽 여백은 CSS 몫). `ratio`가 null(분할이 안 보임)이면 존 쪽 절반,
 * 아니면 그려지는 비율 `clampRatio(ratio, width)` 기준 그 패널. top·height는 rect 그대로.
 */
export function overlayRect(rect: Rect, zone: 'left' | 'right', ratio: number | null): Rect {
  const leftWidth = rect.width * (ratio === null ? 0.5 : clampRatio(ratio, rect.width))
  return zone === 'left'
    ? { ...rect, width: leftWidth }
    : { ...rect, left: rect.left + leftWidth, width: rect.width - leftWidth }
}

/**
 * 오버레이 칩의 세로 자리(explorer-ux-polish X10): 포인터가 rect 아래쪽 절반이면 'top', 위쪽 절반이면
 * 'bottom'. 칩이 포인터(고스트)의 반대쪽 끝에 놓여 콘텐츠 높이가 148px 이상이면 겹치지 않는다.
 */
export function chipSlot(rect: Rect, y: number): 'top' | 'bottom' {
  return y >= rect.top + rect.height / 2 ? 'top' : 'bottom'
}

/** F4 히스테리시스: 탭줄 하단 + 16px 아래로 내려가야 분할, 탭줄 하단선 위로 올라와야 순서 변경. */
export function dragModeFor(
  prev: 'reorder' | 'split',
  y: number,
  stripBottom: number
): 'reorder' | 'split' {
  if (prev === 'reorder') return y > stripBottom + SPLIT_ENTER_PX ? 'split' : 'reorder'
  return y < stripBottom ? 'reorder' : 'split'
}

/** P8·Q4: 두 패널 모두 280px 이상이 되게 자른다. 폭이 560px 이하라 그럴 수 없으면 50:50. */
export function clampRatio(ratio: number, width: number): number {
  const min = PANE_MIN_PX / width
  if (min >= 0.5) return 0.5
  return Math.min(Math.max(ratio, min), (width - PANE_MIN_PX) / width)
}

/** 순서 변경 삽입 위치: 단위(탭 또는 묶음 알약) 가운데 x 가운데 `x`보다 왼쪽인 것의 개수. */
export function insertionIndex(mids: readonly number[], x: number): number {
  return mids.filter((mid) => mid < x).length
}

/**
 * P3: 새 분할의 짝(남는 탭). 끄는 탭이 활성 탭이 아니면 활성 탭, 활성 탭이면 순서상 다음(없으면 앞).
 * 탭이 하나면 null.
 */
export function splitPartner(
  order: readonly string[],
  activeId: string,
  draggedId: string
): string | null {
  if (order.length < 2) return null
  if (draggedId !== activeId) return activeId
  const i = order.indexOf(draggedId)
  return order[i + 1] ?? order[i - 1] ?? null
}
