export interface GridRect {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Returns the indices of grid items whose square cells intersect `rect`
 * (content/scroll-space coordinates).
 *
 * Items are laid out left-to-right, top-to-bottom in `columnCount` columns of
 * `cellSize`-square cells separated by `gap`, with `paddingX` on the left edge —
 * matching the gallery grid's render geometry. `offset` shifts the layout index
 * (e.g. 1 when a leading ".." parent cell occupies the first slot). Returned
 * indices are item indices (already adjusted back for `offset`).
 */
export function itemIndicesInRect(
  rect: GridRect,
  itemCount: number,
  columnCount: number,
  cellSize: number,
  gap: number,
  paddingX: number,
  offset: number
): number[] {
  const result: number[] = []
  if (columnCount < 1) return result
  for (let i = 0; i < itemCount; i++) {
    const layoutIndex = i + offset
    const col = layoutIndex % columnCount
    const row = Math.floor(layoutIndex / columnCount)
    const x = paddingX + col * (cellSize + gap)
    const y = row * (cellSize + gap)
    if (rect.left < x + cellSize && rect.right > x && rect.top < y + cellSize && rect.bottom > y) {
      result.push(i)
    }
  }
  return result
}
