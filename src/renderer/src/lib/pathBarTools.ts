// 경로 막대를 한 줄로 두는 순수 계산(explorer-ux-polish §3): 잰 폭으로 막대에 남길 도구와 ⋯로 접을 도구를 고른다.

export type PathToolId =
  | 'forward'
  | 'reload'
  | 'search'
  | 'filter'
  | 'sort'
  | 'view'
  | 'newFolder'
  | 'info'

/** 막대에 놓이는 순서. ⋯ 메뉴의 항목 순서도 같다(X8) */
export const PATH_TOOL_ORDER: readonly PathToolId[] = [
  'forward',
  'reload',
  'search',
  'filter',
  'sort',
  'view',
  'newFolder',
  'info'
]
/** 오래 남는 순서(X2). 접히는 순서의 역순 */
export const PATH_TOOL_KEEP: readonly PathToolId[] = [
  'search',
  'filter',
  'sort',
  'view',
  'forward',
  'reload',
  'newFolder',
  'info'
]
export const PATH_BAR_PAD_PX = 24 // px-3 좌우
export const PATH_GAP_PX = 6 // gap-1.5
export const CRUMB_MARGIN_PX = 4 // 조각 상자의 ml-1
export const CRUMB_MIN_PX = 160 // X4
export const CRUMB_FLOOR_PX = 96 // X4

export interface PathBarMeasure {
  /** 막대 clientWidth(좌우 여백 포함). 0이면 레이아웃 없음 */
  bar: number
  back: number
  up: number
  /** ⋯ 버튼 */
  more: number
  /** 도구마다 지금 모양의 폭(간격 제외). search는 열렸으면 칸, 아니면 돋보기 */
  tools: Record<PathToolId, number>
}
export interface PathBarFit {
  /** 막대에 보이는 도구(PATH_TOOL_ORDER 순) */
  shown: PathToolId[]
  /** ⋯ 메뉴의 도구(PATH_TOOL_ORDER 순). 비면 ⋯를 그리지 않는다 */
  overflow: PathToolId[]
  /** 열린 찾기 칸이 조각 상자 자리를 대신한다(X6) */
  searchInSlot: boolean
  /** 조각 상자(또는 그 자리의 찾기 칸)가 받는 폭 */
  crumbWidth: number
}

/**
 * 조각 상자에 `CRUMB_MIN_PX`(모자라면 `CRUMB_FLOOR_PX`까지)를 먼저 주고, 남은 예산에 `PATH_TOOL_KEEP`의
 * 앞부분만 남긴다(X3·X4). 열린 찾기 칸이 들어가지 않으면 조각 자리를 대신한다(X6).
 */
export function fitPathTools(m: PathBarMeasure, searchOpen: boolean): PathBarFit {
  if (m.bar <= 0)
    return { shown: [...PATH_TOOL_ORDER], overflow: [], searchInSlot: false, crumbWidth: 0 }
  // 새로 고침은 조각 상자 안이라 간격이 없다.
  const w = (id: PathToolId): number => m.tools[id] + (id === 'reload' ? 0 : PATH_GAP_PX)
  const inner = m.bar - PATH_BAR_PAD_PX
  const fixed = m.back + PATH_GAP_PX + m.up + PATH_GAP_PX + CRUMB_MARGIN_PX
  const all = PATH_TOOL_ORDER.reduce((sum, id) => sum + w(id), 0)
  if (inner - fixed - all >= CRUMB_MIN_PX)
    return {
      shown: [...PATH_TOOL_ORDER],
      overflow: [],
      searchInSlot: false,
      crumbWidth: inner - fixed - all
    }

  const room = inner - fixed - (m.more + PATH_GAP_PX)
  const crumb = Math.min(Math.max(room, CRUMB_FLOOR_PX), CRUMB_MIN_PX)
  let budget = room - crumb
  const keep = new Set<PathToolId>()
  let searchInSlot = false
  for (const id of PATH_TOOL_KEEP) {
    if (w(id) <= budget) {
      keep.add(id)
      budget -= w(id)
    } else if (id === 'search' && searchOpen) searchInSlot = true
    else break
  }
  const shown = PATH_TOOL_ORDER.filter((id) => keep.has(id))
  return {
    shown,
    overflow: PATH_TOOL_ORDER.filter((id) => !keep.has(id) && !(searchInSlot && id === 'search')),
    searchInSlot,
    crumbWidth: room - shown.reduce((sum, id) => sum + w(id), 0)
  }
}
