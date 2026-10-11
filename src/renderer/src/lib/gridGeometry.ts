import { GAP, LABEL_H, PAD, TILE_DEFAULT, TILE_MAX, TILE_MIN, TILE_STEP } from './explorerLayout'

export interface GridRect {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Returns the indices of grid items whose cells intersect `rect`
 * (content/scroll-space coordinates).
 *
 * Items are laid out left-to-right, top-to-bottom in `columnCount` columns of
 * `cellSize`-wide cells separated by `gap`, with `paddingX` on the left edge —
 * matching the gallery grid's render geometry. Cells are square unless
 * `cellHeight` is given (the 4:3 explorer tile: image + label). `offset` shifts
 * the layout index (e.g. 1 when a leading ".." parent cell occupies the first
 * slot). Returned indices are item indices (already adjusted back for `offset`).
 */
export function itemIndicesInRect(
  rect: GridRect,
  itemCount: number,
  columnCount: number,
  cellSize: number,
  gap: number,
  paddingX: number,
  offset: number,
  cellHeight = cellSize
): number[] {
  const result: number[] = []
  if (columnCount < 1) return result
  for (let i = 0; i < itemCount; i++) {
    const layoutIndex = i + offset
    const col = layoutIndex % columnCount
    const row = Math.floor(layoutIndex / columnCount)
    const x = paddingX + col * (cellSize + gap)
    const y = row * (cellHeight + gap)
    if (
      rect.left < x + cellSize &&
      rect.right > x &&
      rect.top < y + cellHeight &&
      rect.bottom > y
    ) {
      result.push(i)
    }
  }
  return result
}

export interface GridLayout {
  cols: number
  cellWidth: number
  /** 4:3로 채우는 이미지 높이 = 셀 폭 × 0.75 */
  imageHeight: number
  /** 이미지 + 라벨 + 간격 */
  rowHeight: number
}

/** 탐색기 그리드: 폭 `width`에 `tile` 크기 타일이 몇 열 들어가는지와 셀 치수. */
export function gridLayout(
  width: number,
  tile: number,
  gap = GAP,
  pad = PAD,
  labelHeight = LABEL_H
): GridLayout {
  const inner = Math.max(0, width - pad * 2)
  const cols = Math.max(1, Math.floor((inner + gap) / (tile + gap)))
  const cellWidth = (inner - gap * (cols - 1)) / cols
  const imageHeight = Math.round(cellWidth * 0.75)
  return { cols, cellWidth, imageHeight, rowHeight: imageHeight + labelHeight + gap }
}

/** 타일 크기를 8px 단계, 96–280으로 자른다. */
export function clampTileSize(px: number): number {
  if (Number.isNaN(px)) return TILE_DEFAULT
  return Math.max(TILE_MIN, Math.min(TILE_MAX, Math.round(px / TILE_STEP) * TILE_STEP))
}
