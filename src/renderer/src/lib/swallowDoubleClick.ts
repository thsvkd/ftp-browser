/** 두 번째 누름이 첫 클릭 자리에서 이만큼 안이면 같은 더블클릭이다(OS의 더블클릭 허용 범위보다 넉넉하게). */
const SLOP_PX = 8
/** 더블클릭의 두 번째 누름을 기다리는 시간. Windows 기본 더블클릭 시간(500ms)을 덮는다. */
const WAIT_MS = 600

/**
 * 첫 클릭이 이미 동작하고 자기 자리를 없앤 더블클릭의 나머지를 삼킨다. 그대로 두면 두 번째 누름이 그 아래에 있던
 * 것에 닿아 포커스를 옮기고, 항목을 고르거나(더블클릭이면) 연다(connect-bar-double-click C1).
 * 마우스 이벤트는 클릭 횟수(`detail` ≥ 2)로, 횟수가 없는 pointerdown은 첫 클릭 자리 근처인지로 가린다. 새 클릭
 * (`detail` 1)이 오거나 시간이 지나면 그만둔다.
 */
export function swallowRestOfDoubleClick(at: { x: number; y: number }): void {
  const done = new AbortController()
  const near = (e: MouseEvent): boolean =>
    Math.abs(e.clientX - at.x) <= SLOP_PX && Math.abs(e.clientY - at.y) <= SLOP_PX
  const swallow = (e: Event): void => {
    e.preventDefault()
    e.stopPropagation()
  }
  const onPointerDown = (e: PointerEvent): void => {
    if (near(e)) swallow(e)
  }
  const onMouse = (e: MouseEvent): void => {
    if (e.detail < 2) {
      done.abort()
      return
    }
    swallow(e)
    if (e.type === 'dblclick') done.abort()
  }
  const opts = { capture: true, signal: done.signal }
  window.addEventListener('pointerdown', onPointerDown, opts)
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick'] as const)
    window.addEventListener(type, onMouse, opts)
  setTimeout(() => done.abort(), WAIT_MS)
}
