import { describe, it, expect } from 'vitest'
import { viewportThumbnailTargets } from './thumbnailViewport'
import type { FtpFileEntry } from '@shared/types/ftp'

const MODIFIED_AT = '2024-05-01T10:20:30.000Z'

function entry(i: number): FtpFileEntry {
  const isDir = i === 7
  const isText = i === 13
  return {
    name: isDir ? 'dir07' : isText ? 'notes13.txt' : `img${String(i).padStart(2, '0')}.jpg`,
    type: isDir ? 'directory' : 'file',
    size: 1000,
    modifiedAt: MODIFIED_AT,
    rawModifiedAt: MODIFIED_AT,
    isImage: !isDir && !isText
  }
}

/** 인덱스 0은 상위 폴더 행, 1~29는 파일. 7은 디렉터리, 13은 이미지가 아닌 파일. 열 3개 → 행 r = 인덱스 3r..3r+2. */
const ITEMS: Array<FtpFileEntry | 'parent'> = [
  'parent',
  ...Array.from({ length: 29 }, (_, k) => entry(k + 1))
]

function indices(targets: ReturnType<typeof viewportThumbnailTargets>): number[] {
  return targets.map((t) => ITEMS.indexOf(t.entry))
}

describe('viewportThumbnailTargets', () => {
  it('returns only image entries within the visible rows plus the margin, clamped to the list', () => {
    // covers: Test-271
    const middle = viewportThumbnailTargets(ITEMS, 3, { startIndex: 3, endIndex: 4 }, 2)
    expect([...indices(middle)].sort((a, b) => a - b)).toEqual([
      3, 4, 5, 6, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20
    ])

    const top = viewportThumbnailTargets(ITEMS, 3, { startIndex: 0, endIndex: 0 }, 2)
    expect(indices(top)).toEqual([1, 2, 3, 4, 5, 6, 8])

    const bottom = viewportThumbnailTargets(ITEMS, 3, { startIndex: 9, endIndex: 9 }, 2)
    expect(indices(bottom)).toEqual([27, 28, 29, 24, 25, 26, 21, 22, 23])
  })

  it('orders visible rows first, then margin rows by distance with the row above first', () => {
    // covers: Test-272
    const targets = viewportThumbnailTargets(ITEMS, 3, { startIndex: 3, endIndex: 4 }, 2)

    expect(indices(targets)).toEqual([9, 10, 11, 12, 14, 6, 8, 15, 16, 17, 3, 4, 5, 18, 19, 20])
    expect(targets.map((t) => t.priority)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2])
  })
})
