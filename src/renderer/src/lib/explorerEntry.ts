/**
 * 탐색기가 그리는 항목 하나. 원격(`FtpFileEntry`)과 로컬(`LocalFileEntry`)을 이 한 형태로 바꿔
 * 두 쪽을 같은 컴포넌트가 그린다. 위치(`Loc`)는 탭·선반·최근 위치·활동 배치가 함께 쓴다.
 */
import { getFileExtension, isHiddenName } from './utils'
import { getParentPath, joinLocalPath } from './localPath'
import type { FtpFileEntry } from '@shared/types/ftp'
import type { LocalFileEntry } from '@shared/types/local'

export type Side = 'local' | 'remote'

/** 어느 쪽의 어느 폴더. `server`는 원격일 때만 `"user@host:port"`다. */
export interface Loc {
  side: Side
  path: string
  server?: string
}

export type EntryCategory =
  | 'image'
  | 'raw'
  | 'video'
  | 'audio'
  | 'archive'
  | 'code'
  | 'doc'
  | 'other'

export interface ExplorerEntry {
  side: Side
  server?: string
  path: string
  name: string
  type: 'file' | 'directory' | 'symbolic-link'
  size: number
  modifiedAt: string
  permissions?: string
  hidden: boolean
  category: EntryCategory
  isImage: boolean
}

const EXT_CATEGORY: Record<string, EntryCategory> = {}
for (const [category, exts] of [
  ['image', 'jpg jpeg png gif webp bmp tif tiff heic heif avif svg ico psd'],
  ['raw', 'cr2 cr3 crw nef nrw arw srf sr2 dng raf orf rw2 pef srw x3f'],
  ['video', 'mp4 mov mkv avi webm m4v wmv mts m2ts 3gp'],
  ['audio', 'mp3 flac wav m4a aac ogg opus wma'],
  ['archive', 'zip rar 7z tar gz tgz bz2 xz iso dmg'],
  [
    'code',
    'js mjs cjs ts tsx jsx html css scss json xml yml yaml py go rs java c cpp h sh ps1 php sql rb'
  ],
  ['doc', 'pdf doc docx xls xlsx ppt pptx odt ods odp txt md rtf hwp hwpx csv log']
] as const) {
  for (const ext of exts.split(' ')) EXT_CATEGORY[`.${ext}`] = category
}

/** 확장자로 나눈 종류. 모르는 확장자와 확장자 없는 이름은 `other`. */
export function categoryOf(name: string): EntryCategory {
  return EXT_CATEGORY[getFileExtension(name)] ?? 'other'
}

export function sameLoc(a: Loc, b: Loc): boolean {
  return a.side === b.side && a.path === b.path && (a.server ?? '') === (b.server ?? '')
}

/** 목록 캐시·선반 중복 검사의 키: `side|server|path`. */
export function locKey(loc: Pick<Loc, 'side' | 'path' | 'server'>): string {
  return `${loc.side}|${loc.server ?? ''}|${loc.path}`
}

export function joinPath(side: Side, dir: string, name: string): string {
  if (side === 'local') return joinLocalPath(dir, name)
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

/** 부모 폴더. 루트면 null. 원격은 늘 `/` 구분자다. */
export function parentPath(side: Side, path: string): string | null {
  if (side === 'local') return getParentPath(path)
  if (path === '/') return null
  const slash = path.lastIndexOf('/')
  return slash <= 0 ? '/' : path.slice(0, slash)
}

function toEntry(
  side: Side,
  path: string,
  e: FtpFileEntry | LocalFileEntry,
  extra: Partial<ExplorerEntry>
): ExplorerEntry {
  return {
    side,
    ...extra,
    path,
    name: e.name,
    type: e.type,
    size: e.size,
    modifiedAt: e.modifiedAt,
    ...('permissions' in e && e.permissions !== undefined ? { permissions: e.permissions } : {}),
    hidden: isHiddenName(e.name),
    category: e.type === 'file' ? categoryOf(e.name) : 'other',
    isImage: e.isImage
  }
}

export function fromFtpEntry(e: FtpFileEntry, dir: string, server: string): ExplorerEntry {
  return toEntry('remote', joinPath('remote', dir, e.name), e, { server })
}

export function fromLocalEntry(e: LocalFileEntry): ExplorerEntry {
  return toEntry('local', e.path, e, {})
}
