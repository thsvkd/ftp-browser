/** 탭이 보이는 목록: 정렬(자연 순서, 폴더 먼저)과 걸러내기(숨김·찾기·사진만). */
import { getFileExtension } from './utils'
import { matchesTypeAhead, normalizeTypedChar } from './typeAhead'
import type { ExplorerEntry } from './explorerEntry'

export type SortKey = 'name' | 'size' | 'modified' | 'type'

export interface SortSpec {
  key: SortKey
  dir: 'asc' | 'desc'
  foldersFirst: boolean
}

export const DEFAULT_SORT: SortSpec = { key: 'name', dir: 'asc', foldersFirst: true }

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

const time = (iso: string): number => Date.parse(iso) || 0

/** 새 배열을 돌려준다. 폴더 먼저면 두 방향 모두 폴더가 위다. 같은 값은 이름 순. */
export function sortEntries(entries: readonly ExplorerEntry[], sort: SortSpec): ExplorerEntry[] {
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...entries].sort((a, b) => {
    const aDir = a.type === 'directory'
    if (sort.foldersFirst && aDir !== (b.type === 'directory')) return aDir ? -1 : 1
    let c = 0
    if (sort.key === 'size') c = a.size - b.size
    else if (sort.key === 'modified') c = time(a.modifiedAt) - time(b.modifiedAt)
    else if (sort.key === 'type')
      c = collator.compare(getFileExtension(a.name), getFileExtension(b.name))
    else return sign * collator.compare(a.name, b.name)
    return sign * c || collator.compare(a.name, b.name)
  })
}

export interface FilterOptions {
  query: string
  photosOnly: boolean
  showHidden: boolean
}

export interface FilterResult {
  visible: ExplorerEntry[]
  /** 숨김 파일이라 빠진 수 */
  hiddenCount: number
  /** 찾기 문자열에 맞지 않아 빠진 수 */
  queryCount: number
  /** 찾기를 통과했지만 사진만 칩으로 빠진 수 */
  photosCount: number
}

const PHOTO_CATEGORIES = new Set(['image', 'raw', 'video'])

/** 숨김 → 찾기 → 사진만 순으로 거르고, 단계마다 빠진 수를 센다. */
export function filterEntries(
  entries: readonly ExplorerEntry[],
  { query, photosOnly, showHidden }: FilterOptions
): FilterResult {
  const q = query.trim().toLowerCase()
  // 한글 초성: 입력해서 고르기와 같은 규칙(ㄴ = s)으로 맞춘다.
  const initials = [...q].map(normalizeTypedChar).join('')
  const result: FilterResult = { visible: [], hiddenCount: 0, queryCount: 0, photosCount: 0 }
  for (const e of entries) {
    if (!showHidden && e.hidden) result.hiddenCount++
    else if (q && !e.name.toLowerCase().includes(q) && !matchesTypeAhead(e.name, initials))
      result.queryCount++
    else if (photosOnly && e.type !== 'directory' && !PHOTO_CATEGORIES.has(e.category))
      result.photosCount++
    else result.visible.push(e)
  }
  return result
}
