/**
 * 탐색기의 선택(경로 기준, 순수). 선택 = 포커스: `focus`는 선택 안의 작업 대상 항목이다
 * (키보드 이동의 출발점, Enter·Space·F2가 쓰는 항목). 모든 연산이 두 불변식을 지킨다:
 * I1 `focus === null || sel.includes(focus)`, I2 `sel.length === 0 ⇒ focus === null`.
 * `anchor`는 범위 선택의 기준점일 뿐이라 선택 밖에 있어도 된다.
 */
import { isToggleSelectModifier, type ModifierState } from './platform'

export interface SelectionState {
  sel: string[]
  anchor: string | null
  focus: string | null
}

/**
 * 키가 옮길 포커스 위치. 그리드는 `cols`열, 쪽 이동은 `pageRows`행씩. 끝에서 자른다.
 * 아직 포커스가 없으면(-1) End는 마지막, 나머지는 첫 항목. 이동 키가 아니거나 비었으면 null.
 */
export function navIndex(
  key: string,
  focus: number,
  count: number,
  cols: number,
  pageRows: number
): number | null {
  if (count === 0) return null
  const step: Record<string, number> = {
    ArrowDown: cols,
    ArrowUp: -cols,
    ArrowRight: 1,
    ArrowLeft: -1,
    PageDown: pageRows * cols,
    PageUp: -pageRows * cols
  }
  let target: number
  if (key === 'Home') target = 0
  else if (key === 'End') target = count - 1
  else if (key in step) target = focus < 0 ? 0 : focus + step[key]
  else return null
  return Math.max(0, Math.min(count - 1, target))
}

function range(paths: readonly string[], a: string, b: string): string[] {
  const i = Math.max(0, paths.indexOf(a))
  const j = Math.max(0, paths.indexOf(b))
  return paths.slice(Math.min(i, j), Math.max(i, j) + 1)
}

/**
 * 키보드로 `index`의 항목을 고른다. Shift는 앵커부터 범위, Shift+Ctrl은 범위를 기존 선택에
 * 더한다. Ctrl 단독은 수정자 없는 이동과 같다.
 */
export function moveFocus(
  state: SelectionState,
  paths: readonly string[],
  index: number,
  mods: { shift: boolean; ctrl: boolean }
): SelectionState {
  const p = paths[index]
  if (mods.shift) {
    const anchor = state.anchor ?? state.focus ?? p
    const r = range(paths, anchor, p)
    return { sel: mods.ctrl ? [...new Set([...state.sel, ...r])] : r, anchor, focus: p }
  }
  return { sel: [p], anchor: p, focus: p }
}

/**
 * 하나를 선택에 넣거나 뺀다(토글 수정자 클릭, 체크 원, Ctrl+Space). 앵커는 누른 경로로 옮긴다.
 * 더하면 포커스도 그 경로, 빼면 남은 선택의 마지막(없으면 null).
 */
export function toggleSelect(state: SelectionState, path: string): SelectionState {
  if (!state.sel.includes(path)) return { sel: [...state.sel, path], anchor: path, focus: path }
  const sel = state.sel.filter((s) => s !== path)
  return { sel, anchor: path, focus: sel.at(-1) ?? null }
}

/** 선택·앵커·포커스를 모두 푼다(빈 곳 클릭, Esc, 삭제 뒤). */
export const clearSelection = (): SelectionState => ({ sel: [], anchor: null, focus: null })

/** 마퀴가 고른 경로들로 바꾼다. 포커스는 마지막, 앵커는 선택 안이면 그대로 아니면 첫 항목. */
export function selectMany(state: SelectionState, paths: readonly string[]): SelectionState {
  const sel = [...new Set(paths)]
  if (!sel.length) return clearSelection()
  const anchor = state.anchor && sel.includes(state.anchor) ? state.anchor : sel[0]
  return { sel, anchor, focus: sel[sel.length - 1] }
}

/** 보이는 항목 전체 선택(Ctrl+A). 앵커는 그대로, 포커스는 보이는 목록에 없으면 null(I1). */
export function selectAll(state: SelectionState, paths: readonly string[]): SelectionState {
  const sel = [...new Set(paths)]
  if (!sel.length) return clearSelection()
  return {
    sel,
    anchor: state.anchor,
    focus: state.focus && sel.includes(state.focus) ? state.focus : null
  }
}

/** 클릭. 토글 수정자는 플랫폼마다 다르다(Windows Ctrl, macOS Cmd). */
export function clickSelect(
  state: SelectionState,
  paths: readonly string[],
  path: string,
  e: ModifierState & { shiftKey: boolean },
  platform: string
): SelectionState {
  const toggle = isToggleSelectModifier(e, platform)
  if (e.shiftKey) {
    const anchor = state.anchor ?? path
    const r = range(paths, anchor, path)
    return { sel: toggle ? [...new Set([...state.sel, ...r])] : r, anchor, focus: path }
  }
  if (toggle) return toggleSelect(state, path)
  return { sel: [path], anchor: path, focus: path }
}
