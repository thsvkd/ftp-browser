/** 두 번째 누름이 첫 클릭 자리에서 이만큼 안이면 같은 더블클릭일 수 있다(OS의 더블클릭 허용 범위보다 넉넉하게). */
const SLOP_PX = 8
/**
 * 남은 누름을 기다리는 시간. 느리게 맞춘 더블클릭 설정(Windows 최대 900ms)과 세 번 클릭을 덮는다. 같은 클릭의
 * 이어짐인지는 클릭 횟수가 정하므로 오래 기다려도 새 클릭을 막지 않는다.
 */
export const SWALLOW_WAIT_MS = 1500

/**
 * 첫 클릭이 이미 동작하고 자기 자리를 없앤 더블클릭의 나머지를 삼킨다. 그대로 두면 두 번째 누름이 그 아래에 있던
 * 것에 닿아 포커스를 옮기고, 항목을 고르거나(더블클릭이면) 연다(connect-bar-double-click C1).
 *
 * 기본 버튼만 본다. Chromium의 pointerdown은 클릭 횟수가 없으므로 첫 클릭 자리 근처의 누름은 전파만 막고(기본
 * 동작은 두어 mousedown이 오게 한다), 뒤따르는 mousedown·mouseup·click·dblclick은 클릭 횟수(`detail` ≥ 2)로
 * 가린다. 그 누름의 mousedown을 삼켰으면 pointerup도 삼킨다. 횟수 1인 새 클릭이 오거나 시간이 지나면 그만둔다(C2).
 */
export function swallowRestOfDoubleClick(at: { x: number; y: number }): void {
  const done = new AbortController()
  let pressSwallowed = false
  const near = (e: MouseEvent): boolean =>
    Math.abs(e.clientX - at.x) <= SLOP_PX && Math.abs(e.clientY - at.y) <= SLOP_PX
  const swallow = (e: Event): void => {
    e.preventDefault()
    e.stopPropagation()
  }
  const onPointerDown = (e: PointerEvent): void => {
    if (e.button === 0 && near(e)) e.stopPropagation()
  }
  const onPointerUp = (e: PointerEvent): void => {
    if (e.button !== 0 || !pressSwallowed) return
    pressSwallowed = false
    swallow(e)
  }
  const onMouse = (e: MouseEvent): void => {
    if (e.button !== 0) return
    if (e.detail < 2) {
      done.abort()
      return
    }
    if (e.type === 'mousedown') pressSwallowed = true
    swallow(e)
  }
  const opts = { capture: true, signal: done.signal }
  window.addEventListener('pointerdown', onPointerDown, opts)
  window.addEventListener('pointerup', onPointerUp, opts)
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick'] as const)
    window.addEventListener(type, onMouse, opts)
  setTimeout(() => done.abort(), SWALLOW_WAIT_MS)
}
