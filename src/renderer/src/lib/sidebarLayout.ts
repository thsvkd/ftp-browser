/**
 * 접이식·리사이즈 사이드바의 순수 계산(docs/handoff/collapsible-sidebars.md §4).
 * React·DOM·스토어를 import하지 않는다. 모든 수는 px 정수다.
 */

export type PaneSide = 'left' | 'right'

export interface PaneSpec {
  readonly min: number
  readonly def: number
  readonly max: number
}

export interface PaneState {
  width: number
  collapsed: boolean
}

/** 폭 수치(D2). `globals.css` `:root`의 변수와 같은 값이어야 한다(Test-900). */
export const PANE_SPECS: Record<PaneSide, PaneSpec> = {
  left: { min: 180, def: 220, max: 360 },
  right: { min: 240, def: 288, max: 480 }
}

/** 접힘 거리 = min × SNAP_RATIO (D4) */
export const SNAP_RATIO = 0.5
/** 본문이 이보다 좁아지지 않게 두 패널을 맞춘다(D12) */
export const CENTER_MIN = 480
/** 키 하나로 늘리고 줄이는 폭, Shift면 큰 폭(D7) */
export const KEY_STEP = 16
export const KEY_STEP_LARGE = 64
/** `--pane-anim`과 같은 값(D3·D5) */
export const PANE_ANIM_MS = 200

/** 정수로 반올림해 [min, maxWidth ?? max]로 자른다. 유한하지 않으면 기본 폭. */
export function clampPaneWidth(side: PaneSide, width: number, maxWidth?: number): number {
  const spec = PANE_SPECS[side]
  if (!Number.isFinite(width)) return spec.def
  const hi = Math.max(spec.min, maxWidth ?? spec.max)
  return Math.min(hi, Math.max(spec.min, Math.round(width)))
}

export const collapseAt = (side: PaneSide): number =>
  PANE_SPECS[side].min - PANE_SPECS[side].min * SNAP_RATIO
export const expandAt = (side: PaneSide): number => PANE_SPECS[side].min

/** 포인터가 가리키는 폭. start는 드래그 시작 때 화면에 그려진 상태(맞춤 적용값)다. */
export function dragRaw(side: PaneSide, start: PaneState, x0: number, x: number): number {
  const base = start.collapsed ? 0 : start.width
  return side === 'left' ? base + (x - x0) : base - (x - x0)
}

/** D4. 접힘이면 width는 0. 펼침이면 clampPaneWidth(raw, maxWidth). */
export function resolveDrag(
  side: PaneSide,
  raw: number,
  wasCollapsed: boolean,
  maxWidth?: number
): { collapsed: boolean; width: number } {
  const collapsed = wasCollapsed ? raw < expandAt(side) : raw <= collapseAt(side)
  return collapsed
    ? { collapsed: true, width: 0 }
    : { collapsed: false, width: clampPaneWidth(side, raw, maxWidth) }
}

/** D15. 놓을 때 저장할 상태. start는 드래그 시작 때의 저장된 상태다. */
export function settleDrag(
  start: PaneState,
  live: { collapsed: boolean; width: number }
): PaneState {
  return live.collapsed
    ? { width: start.width, collapsed: true }
    : { width: live.width, collapsed: false }
}

export const togglePane = (s: PaneState): PaneState => ({ ...s, collapsed: !s.collapsed })
export const resetPane = (side: PaneSide): PaneState => ({
  width: PANE_SPECS[side].def,
  collapsed: false
})

export type PaneKeyAction =
  | { kind: 'grow' | 'shrink'; step: number }
  | { kind: 'min' | 'max' | 'toggle' }

/** 늘림 방향은 왼쪽 핸들 → / 오른쪽 핸들 ←. Shift면 step=KEY_STEP_LARGE. 그 밖의 키는 null. */
export function paneKeyAction(side: PaneSide, key: string, shift: boolean): PaneKeyAction | null {
  const step = shift ? KEY_STEP_LARGE : KEY_STEP
  const growKey = side === 'left' ? 'ArrowRight' : 'ArrowLeft'
  const shrinkKey = side === 'left' ? 'ArrowLeft' : 'ArrowRight'
  if (key === growKey) return { kind: 'grow', step }
  if (key === shrinkKey) return { kind: 'shrink', step }
  if (key === 'Home') return { kind: 'min' }
  if (key === 'End') return { kind: 'max' }
  if (key === 'Enter') return { kind: 'toggle' }
  return null
}

/** 키로는 접히지 않는다(D7). 접힌 상태: grow=기억 폭으로 펼침, min/max=그 폭으로 펼침, shrink=무변화. */
export function applyPaneKey(
  side: PaneSide,
  s: PaneState,
  a: PaneKeyAction,
  maxWidth?: number
): PaneState {
  const spec = PANE_SPECS[side]
  if (a.kind === 'grow' || a.kind === 'shrink') {
    if (s.collapsed) return a.kind === 'grow' ? { width: s.width, collapsed: false } : s
    const delta = a.kind === 'grow' ? a.step : -a.step
    return { width: clampPaneWidth(side, s.width + delta, maxWidth), collapsed: false }
  }
  if (a.kind === 'toggle') return togglePane(s)
  const width = a.kind === 'min' ? spec.min : clampPaneWidth(side, spec.max, maxWidth)
  return { width, collapsed: false }
}

/** D12. otherWidth = 반대쪽 화면 폭(드래그 시작 때 값). 컨테이너를 모르면 spec.max. */
export function dragMax(side: PaneSide, container: number | null, otherWidth: number): number {
  const spec = PANE_SPECS[side]
  if (!container) return spec.max
  return Math.min(spec.max, Math.max(spec.min, container - CENTER_MIN - otherWidth))
}

/** D12. 렌더용 폭(접힘 0). 합이 컨테이너 − CENTER_MIN 이내거나 컨테이너를 모르면 그대로. */
export function fitPaneWidths(
  container: number | null,
  left: PaneState,
  right: PaneState,
  priority?: PaneSide | null
): { left: number; right: number } {
  const effL = left.collapsed ? 0 : left.width
  const effR = right.collapsed ? 0 : right.width
  if (!container) return { left: effL, right: effR }
  const excess = effL + effR - (container - CENTER_MIN)
  if (excess <= 0) return { left: effL, right: effR }

  const slackL = left.collapsed ? 0 : Math.max(0, effL - PANE_SPECS.left.min)
  const slackR = right.collapsed ? 0 : Math.max(0, effR - PANE_SPECS.right.min)
  let cutL: number
  let cutR: number
  if (priority === 'left') {
    cutR = Math.min(slackR, excess)
    cutL = Math.min(slackL, excess - cutR)
  } else if (priority === 'right') {
    cutL = Math.min(slackL, excess)
    cutR = Math.min(slackR, excess - cutL)
  } else {
    const total = slackL + slackR
    cutL = total ? Math.min(slackL, Math.round((excess * slackL) / total)) : 0
    cutR = Math.min(slackR, excess - cutL)
    cutL = Math.min(slackL, excess - cutR)
  }
  return { left: effL - cutL, right: effR - cutR }
}

/** 저장소에서 읽은 값 고치기: 객체가 아니면 기본값, width는 clampPaneWidth, collapsed는 true일 때만 true. */
export function sanitizePaneState(side: PaneSide, raw: unknown): PaneState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return resetPane(side)
  const { width, collapsed } = raw as { width?: unknown; collapsed?: unknown }
  return {
    width: clampPaneWidth(side, typeof width === 'number' ? width : NaN),
    collapsed: collapsed === true
  }
}

export interface PaneShortcutEvent {
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  altGraph: boolean
}

/** D10. 키는 `code`로 본다(macOS ⌥B의 `key`는 `∫`). 맞으면 'left' | 'right', 아니면 null. */
export function matchPaneShortcut(e: PaneShortcutEvent, platform: string): PaneSide | null {
  if (e.code !== 'KeyB' || e.shiftKey || e.altGraph) return null
  const mac = platform === 'darwin'
  const modifierOk = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!modifierOk) return null
  return e.altKey ? 'right' : 'left'
}

export function formatPaneShortcut(side: PaneSide, platform: string): string {
  if (platform === 'darwin') return side === 'left' ? '⌘B' : '⌥⌘B'
  return side === 'left' ? 'Ctrl+B' : 'Ctrl+Alt+B'
}
