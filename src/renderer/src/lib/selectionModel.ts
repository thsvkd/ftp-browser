/**
 * 탐색기의 포커스 커서와 선택(경로 기준, 순수). 포커스 커서는 선택과 따로 움직인다:
 * 그냥 이동은 단일 선택, Shift는 앵커부터 범위, Ctrl은 포커스만 옮긴다.
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

/** 키보드로 `index`에 포커스를 옮긴다. Shift+Ctrl은 범위를 기존 선택에 더한다. */
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
  if (mods.ctrl) return { ...state, focus: p }
  return { sel: [p], anchor: p, focus: p }
}

/** 하나를 선택에 넣거나 뺀다(토글 수정자 클릭, Ctrl+Space). 앵커도 그리로 옮긴다. */
export function toggleSelect(state: SelectionState, path: string): SelectionState {
  return {
    sel: state.sel.includes(path) ? state.sel.filter((s) => s !== path) : [...state.sel, path],
    anchor: path,
    focus: path
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
