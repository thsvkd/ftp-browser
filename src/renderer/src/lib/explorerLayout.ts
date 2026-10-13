// 탐색기 치수(px)와 시간 상수. 랩 V2의 노브 기본값이 제품 상수가 됐다(H1).
export const PAD = 16
export const GAP = 12
/** 그리드 타일 아래 이름·부가 정보 줄 높이 */
export const LABEL_H = 46
/** 리스트 행 높이 */
export const ROW = 36
/** 리스트 열 머리 높이 */
export const HEAD = 34
export const LIST_COLS = 'grid-cols-[minmax(0,1fr)_96px_150px_96px]'

/** 드래그 중 탭·장소·폴더 위에 머무르면 열리는 시간 */
export const SPRING_MS = 600

export const TILE_DEFAULT = 160
export const TILE_MIN = 96
export const TILE_MAX = 280
export const TILE_STEP = 8

/**
 * `aria-activedescendant`용 항목 id. 영숫자·`-` 밖의 글자는 `_코드_`로 바꿔 경로마다 다르다.
 * `scope`(탭 id, 분할 보기에서만)가 있으면 `opt-<scope>-…`로 두 패널의 같은 경로를 가른다(split-view P9).
 */
export const optId = (path: string, scope?: string): string =>
  `opt-${scope ? `${scope}-` : ''}${path.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(36)}_`)}`

// 분할 보기(split-view.md §3.3)
/** 탭 pointerdown 뒤 이만큼 움직이면 드래그 시작 */
export const TAB_DRAG_START_PX = 4
/** 탭줄 하단에서 이만큼 더 내려가면 분할 모드 */
export const SPLIT_ENTER_PX = 16
/** 존 안에서 이만큼 머물면 오버레이 */
export const SPLIT_DWELL_MS = 60
/** 왼쪽·오른쪽 존의 폭 비율(가운데는 나머지 34%) */
export const SPLIT_EDGE = 0.33
/** 분할 패널 최소 폭 */
export const PANE_MIN_PX = 280
export const SPLIT_FADE_MS = 150
export const SPLIT_SWITCH_MS = 100
/** 새 분할 구분선이 자리 잡는 시간(CSS는 `--pane-anim`) */
export const SPLIT_SETTLE_MS = 200
/** 끄는 탭 고스트의 자리: left = x − DX, top = y − HALF_H(높이 36, `h-9`) */
export const TAB_GHOST_DX = 20
export const TAB_GHOST_HALF_H = 18
/** 오버레이 칩이 영역 위·아래 끝에서 들어오는 거리와 칩 높이 상한(explorer-ux-polish X10) */
export const SPLIT_CHIP_INSET_PX = 24
export const SPLIT_CHIP_H_PX = 32
