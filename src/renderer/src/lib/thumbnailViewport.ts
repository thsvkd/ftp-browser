import type { FtpFileEntry } from '@shared/types/ftp'

export interface ThumbnailTarget {
  entry: FtpFileEntry
  /** 보이는 행 범위로부터의 행 거리. 보이는 행은 0. 낮을수록 먼저 받는다. */
  priority: number
}

/**
 * 그리드의 보이는 행 범위 ± marginRows 행 안에 있는 이미지 항목을 받을 순서대로 돌려준다.
 * 보이는 행이 먼저(priority 0), 그다음 거리 1, 2… 의 마진 행이다. 같은 거리면 위 행 먼저,
 * 행 안에서는 왼쪽부터. 'parent'와 이미지가 아닌 항목은 건너뛰고, 행은 [0, 마지막 행]으로 자른다.
 */
export function viewportThumbnailTargets(
  items: ReadonlyArray<FtpFileEntry | 'parent'>,
  columnCount: number,
  visibleRows: { startIndex: number; endIndex: number },
  marginRows: number
): ThumbnailTarget[] {
  const rows: Array<{ row: number; priority: number }> = []
  for (let row = visibleRows.startIndex; row <= visibleRows.endIndex; row++) {
    rows.push({ row, priority: 0 })
  }
  for (let distance = 1; distance <= marginRows; distance++) {
    rows.push({ row: visibleRows.startIndex - distance, priority: distance })
    rows.push({ row: visibleRows.endIndex + distance, priority: distance })
  }

  const targets: ThumbnailTarget[] = []
  for (const { row, priority } of rows) {
    // 마지막 행 너머는 slice가 빈 배열을 돌려주므로 음수 행만 거른다
    if (row < 0) continue
    for (const item of items.slice(row * columnCount, (row + 1) * columnCount)) {
      if (item !== 'parent' && item.isImage) targets.push({ entry: item, priority })
    }
  }
  return targets
}
