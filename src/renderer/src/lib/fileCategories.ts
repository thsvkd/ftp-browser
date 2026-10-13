/**
 * 파일 종류 필터의 순수 로직: 카테고리 정의(기본 + 사용자 편집분), 확장자 정규화·추출, 매처, 개수.
 * 아이콘·정보 패널 분류(`explorerEntry.ts`의 `categoryOf`)와 썸네일 대상은 건드리지 않는다(E8).
 */
import type { MessageKey } from '@renderer/i18n'
import type { ExplorerEntry } from './explorerEntry'

export type DefaultCategoryId = 'image' | 'raw' | 'video' | 'audio' | 'doc' | 'archive' | 'code'

/** 탭 하나의 필터. 셋 다 비면 필터 없음. 전체가 합집합(OR)이다. */
export interface TabFilter {
  categories: string[]
  extensions: string[]
  noExtension: boolean
}

/** 기본 카테고리 하나에 대한 사용자 편집분: 기본 목록과의 차이만 저장한다(E13). */
export interface DefaultEdit {
  added: string[]
  removed: string[]
  hidden: boolean
}

export interface CustomCategory {
  id: string
  name: string
  extensions: string[]
}

export interface CategoryOverrides {
  defaults: Partial<Record<DefaultCategoryId, DefaultEdit>>
  custom: CustomCategory[]
}

export interface ResolvedCategory {
  id: string
  kind: 'default' | 'custom'
  nameKey?: MessageKey
  name?: string
  /** 유효 목록(기본 − removed ∪ added, 정규화·중복 없음) */
  extensions: string[]
  hidden: boolean
}

export type EntryMatcher = (e: Pick<ExplorerEntry, 'name' | 'type'>) => boolean

export const EMPTY_FILTER: TabFilter = Object.freeze({
  categories: Object.freeze([]) as unknown as string[],
  extensions: Object.freeze([]) as unknown as string[],
  noExtension: false
})

export const EMPTY_OVERRIDES: CategoryOverrides = Object.freeze({
  defaults: Object.freeze({}),
  custom: Object.freeze([]) as unknown as CustomCategory[]
})

const words = (s: string): readonly string[] => s.split(' ')

export const DEFAULT_CATEGORIES: readonly { id: DefaultCategoryId; extensions: readonly string[] }[] =
  [
    { id: 'image', extensions: words('jpg jpeg png gif webp bmp tif tiff svg heic heif avif ico psd') },
    { id: 'raw', extensions: words('cr2 cr3 nef arw dng orf rw2 raf srw pef crw nrw srf sr2 x3f') },
    {
      id: 'video',
      extensions: words('mp4 mkv mov avi wmv flv webm m4v mpg mpeg m2ts mts 3gp')
    },
    { id: 'audio', extensions: words('mp3 flac wav aac m4a ogg opus wma aiff') },
    {
      id: 'doc',
      extensions: words(
        'pdf doc docx xls xlsx ppt pptx odt ods odp txt md rtf csv epub hwp hwpx log'
      )
    },
    { id: 'archive', extensions: words('zip rar 7z tar gz tgz bz2 xz zst iso dmg') },
    {
      id: 'code',
      extensions: words(
        'js ts jsx tsx py java c cpp h cs go rs rb php sh ps1 json yaml yml toml xml html css sql mjs cjs scss'
      )
    }
  ]

/** 앞뒤 공백·앞쪽 점을 지우고 소문자로. 쓸 수 없는 값(빈 값, 공백·슬래시, 끝 점, `..`)은 null. */
export function normalizeExtension(raw: string): string | null {
  const ext = raw.trim().toLowerCase().replace(/^\.+/, '')
  if (!ext || /[\s/\\]/.test(ext) || ext.endsWith('.') || ext.includes('..')) return null
  return ext
}

/** 쉼표·세미콜론·공백으로 쪼갠 입력. 유효한 것은 입력 순서대로 중복 없이, 실패한 토큰은 원문 그대로. */
export function parseExtensionInput(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = []
  const invalid: string[] = []
  for (const token of text.split(/[,;\s]+/)) {
    if (!token) continue
    const ext = normalizeExtension(token)
    if (ext === null) invalid.push(token)
    else if (!valid.includes(ext)) valid.push(ext)
  }
  return { valid, invalid }
}

/** 마지막 점 뒤(소문자). 점이 없거나 맨 앞(`.gitignore`)뿐이거나 맨 끝(`a.`)이면 ''. */
export function extensionOf(name: string): string {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot <= 0 || dot === lower.length - 1 ? '' : lower.slice(dot + 1)
}

const unique = (list: readonly string[]): string[] => [...new Set(list)]

/** 기본 목록(기본 − removed ∪ added)과 사용자 카테고리를 한 목록으로. 기본 뒤에 사용자 순서. */
export function resolveCategories(
  o: CategoryOverrides,
  defaults: typeof DEFAULT_CATEGORIES = DEFAULT_CATEGORIES
): ResolvedCategory[] {
  const out: ResolvedCategory[] = defaults.map((d) => {
    const edit = o.defaults[d.id]
    const removed = new Set(edit?.removed)
    return {
      id: d.id,
      kind: 'default',
      nameKey: `category.${d.id}` as MessageKey,
      extensions: unique([...d.extensions.filter((e) => !removed.has(e)), ...(edit?.added ?? [])]),
      hidden: edit?.hidden ?? false
    }
  })
  for (const c of o.custom)
    out.push({
      id: c.id,
      kind: 'custom',
      name: c.name,
      extensions: unique(c.extensions),
      hidden: false
    })
  return out
}

export function visibleCategories(all: ResolvedCategory[]): ResolvedCategory[] {
  return all.filter((c) => !c.hidden)
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function cleanExtensions(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) {
    const ext = typeof item === 'string' ? normalizeExtension(item) : null
    if (ext !== null && !out.includes(ext)) out.push(ext)
  }
  return out
}

/** 저장분(손상됐을 수 있음)을 안전한 모양으로. 알 수 없는 키·항목은 버리고 던지지 않는다. */
export function sanitizeOverrides(raw: unknown): CategoryOverrides {
  if (!isRecord(raw)) return EMPTY_OVERRIDES
  const defaults: CategoryOverrides['defaults'] = {}
  if (isRecord(raw.defaults)) {
    for (const d of DEFAULT_CATEGORIES) {
      const edit = raw.defaults[d.id]
      if (!isRecord(edit)) continue
      defaults[d.id] = {
        added: cleanExtensions(edit.added),
        removed: cleanExtensions(edit.removed),
        hidden: edit.hidden === true
      }
    }
  }
  const custom: CustomCategory[] = []
  if (Array.isArray(raw.custom)) {
    for (const c of raw.custom) {
      if (!isRecord(c) || typeof c.id !== 'string' || !c.id || typeof c.name !== 'string') continue
      const name = c.name.trim()
      if (!name || custom.some((x) => x.id === c.id)) continue
      custom.push({ id: c.id, name, extensions: cleanExtensions(c.extensions) })
    }
  }
  return { defaults, custom }
}

/** 확장자 집합(점 포함 항목은 복합 접미사)과 "확장자 없음"으로 만든 판정기. */
function compile(exts: Iterable<string>, noExtension: boolean): EntryMatcher {
  const set = new Set(exts)
  const compound = [...set].filter((e) => e.includes('.'))
  return (e) => {
    if (e.type === 'directory') return true
    const ext = extensionOf(e.name)
    if ((noExtension && ext === '') || set.has(ext)) return true
    if (!compound.length) return false
    const lower = e.name.toLowerCase()
    return compound.some((c) => lower.endsWith(`.${c}`) && lower.length > c.length + 1)
  }
}

/** 필터에 걸린 id 중 보이는 카테고리로 해석되는 것(E15). */
function activeCategories(f: TabFilter, categories: ResolvedCategory[]): ResolvedCategory[] {
  const found: ResolvedCategory[] = []
  for (const id of f.categories) {
    const c = categories.find((x) => x.id === id && !x.hidden)
    if (c && !found.includes(c)) found.push(c)
  }
  return found
}

/** 필터가 없으면 null. 폴더는 늘 통과한다. */
export function createMatcher(f: TabFilter, categories: ResolvedCategory[]): EntryMatcher | null {
  const set = new Set<string>(f.extensions)
  for (const c of activeCategories(f, categories)) for (const e of c.extensions) set.add(e)
  if (!set.size && !f.noExtension) return null
  return compile(set, f.noExtension)
}

/** 배지에 세는 수: 해석되는 카테고리 + 확장자 + "확장자 없음". */
export function activeCount(f: TabFilter, categories: ResolvedCategory[]): number {
  return activeCategories(f, categories).length + f.extensions.length + (f.noExtension ? 1 : 0)
}

/** 보이는 카테고리마다 파일 수(0 포함). 폴더는 세지 않고, 두 카테고리에 있는 파일은 양쪽에 센다. */
export function countByCategory(
  files: readonly ExplorerEntry[],
  categories: ResolvedCategory[]
): Record<string, number> {
  const visible = visibleCategories(categories)
  const matchers = visible.map((c) => compile(c.extensions, false))
  const counts: Record<string, number> = Object.fromEntries(visible.map((c) => [c.id, 0]))
  for (const f of files) {
    if (f.type === 'directory') continue
    matchers.forEach((m, i) => {
      if (m(f)) counts[visible[i].id]++
    })
  }
  return counts
}

/** 폴더의 확장자별 파일 수(개수 내림차순 → 확장자 오름차순). 확장자 없는 파일은 따로 센다. */
export function extensionCounts(files: readonly ExplorerEntry[]): {
  exts: { ext: string; count: number }[]
  noExtension: number
} {
  const byExt = new Map<string, number>()
  let noExtension = 0
  for (const f of files) {
    if (f.type === 'directory') continue
    const ext = extensionOf(f.name)
    if (ext === '') noExtension++
    else byExt.set(ext, (byExt.get(ext) ?? 0) + 1)
  }
  const exts = [...byExt].map(([ext, count]) => ({ ext, count }))
  exts.sort((a, b) => b.count - a.count || (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0))
  return { exts, noExtension }
}

/** 필터의 확장자 중 현재 폴더에 없는 것(E30). 입력 순서를 지키고 입력을 바꾸지 않는다. */
export function orphanExtensions(
  filterExtensions: readonly string[],
  folderExts: readonly string[]
): string[] {
  const here = new Set(folderExts)
  return filterExtensions.filter((e) => !here.has(e))
}

/** `이미지, RAW, .log, (확장자 없음)` 같은 요약. `max`개를 넘으면 ` +N`. */
export function filterLabel(
  f: TabFilter,
  categories: ResolvedCategory[],
  nameOf: (c: ResolvedCategory) => string,
  noExtLabel: string,
  max = 3
): string {
  const parts = [
    ...activeCategories(f, categories).map(nameOf),
    ...f.extensions.map((e) => `.${e}`),
    ...(f.noExtension ? [noExtLabel] : [])
  ]
  return parts.length > max
    ? `${parts.slice(0, max).join(', ')} +${parts.length - max}`
    : parts.join(', ')
}
