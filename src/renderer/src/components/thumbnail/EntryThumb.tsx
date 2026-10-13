import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  Link2,
  type LucideIcon
} from 'lucide-react'
import { cn, getFileExtension } from '@renderer/lib/utils'
import type { EntryCategory, ExplorerEntry } from '@renderer/lib/explorerEntry'
import { LocalFolderThumbnail } from './LocalFolderThumbnail'
import { RemoteFolderThumbnail } from './RemoteFolderThumbnail'
import { LocalThumbnailImage } from './LocalThumbnailImage'
import { ThumbnailImage } from './ThumbnailImage'

const CATEGORY_ICON: Record<EntryCategory, LucideIcon> = {
  image: FileImage,
  raw: FileImage,
  video: FileVideo,
  audio: FileAudio,
  archive: FileArchive,
  code: FileCode,
  doc: FileText,
  other: File
}

/** 종류별 글리프 색. 밝고 어두운 바탕 모두에서 읽힌다. */
const CATEGORY_COLOR: Record<EntryCategory, string> = {
  image: 'text-sky-500',
  raw: 'text-cyan-600',
  video: 'text-violet-500',
  audio: 'text-pink-500',
  archive: 'text-orange-500',
  code: 'text-emerald-500',
  doc: 'text-blue-500',
  other: 'text-slate-400'
}

export interface EntryThumbProps {
  entry: ExplorerEntry
  /** 글리프 크기(Tailwind 클래스) */
  glyph?: string
  /** 폴더면 폴더 미리보기(안의 첫 사진 + 개수)를 그린다. 리스트 행처럼 작은 칸은 끈다. */
  folderPreview?: boolean
  /** 3초 넘게 기다리면 "느린 응답"을 보인다 */
  showSlow?: boolean
  /** 그리드 밖: 원격 썸네일을 마운트 때 한 건 요청한다(D30) */
  request?: boolean
  /** 폴더 미리보기 크기(px) */
  size?: number
  /** 글리프 아래 확장자 배지. 리스트 행처럼 작은 칸은 끈다 */
  ext?: boolean
}

function Glyph({
  entry,
  glyph,
  ext: showExt
}: {
  entry: ExplorerEntry
  glyph: string
  ext: boolean
}): React.JSX.Element {
  if (entry.type === 'directory')
    return (
      <Folder
        aria-hidden
        className={cn(glyph, 'fill-amber-400/25 text-amber-500')}
        strokeWidth={1.5}
      />
    )
  const Icon = entry.type === 'symbolic-link' ? Link2 : CATEGORY_ICON[entry.category]
  const ext = getFileExtension(entry.name).slice(1)
  return (
    <span className="flex flex-col items-center gap-1.5">
      <Icon aria-hidden className={cn(glyph, CATEGORY_COLOR[entry.category])} strokeWidth={1.5} />
      {showExt && ext && ext.length <= 5 && (
        <span
          className={cn(
            'mono rounded px-1 text-[9.5px] font-semibold uppercase',
            CATEGORY_COLOR[entry.category]
          )}
        >
          {ext}
        </span>
      )}
    </span>
  )
}

/**
 * 항목 하나의 썸네일: 이미지(원격은 `ThumbnailImage`, 로컬은 `LocalThumbnailImage`), 폴더 미리보기,
 * 그 밖은 종류 글리프. 대기는 shimmer, 3초 넘으면 "느린 응답", 실패는 누르면 재시도.
 */
export function EntryThumb({
  entry,
  glyph = 'h-9 w-9',
  folderPreview = false,
  showSlow = true,
  request = false,
  size = 160,
  ext = true
}: EntryThumbProps): React.JSX.Element {
  if (entry.type === 'directory' && folderPreview)
    return entry.side === 'remote' ? (
      <RemoteFolderThumbnail server={entry.server ?? ''} folderPath={entry.path} size={size} />
    ) : (
      <LocalFolderThumbnail folderPath={entry.path} size={size} />
    )
  if (entry.isImage && entry.type === 'file')
    return entry.side === 'remote' ? (
      <ThumbnailImage entry={entry} remotePath={entry.path} request={request} showSlow={showSlow} />
    ) : (
      <LocalThumbnailImage
        localPath={entry.path}
        fileSize={entry.size}
        modifiedAt={entry.modifiedAt}
        showSlow={showSlow}
      />
    )
  return (
    <div className="flex h-full w-full items-center justify-center">
      <Glyph entry={entry} glyph={glyph} ext={ext} />
    </div>
  )
}
