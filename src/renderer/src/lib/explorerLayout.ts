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

/** `aria-activedescendant`용 항목 id. 영숫자·`-` 밖의 글자는 `_코드_`로 바꿔 경로마다 다르다. */
export const optId = (path: string): string =>
  `opt-${path.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(36)}_`)}`
