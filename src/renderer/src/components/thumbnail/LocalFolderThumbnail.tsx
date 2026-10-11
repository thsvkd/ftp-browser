import { useEffect, useRef, useCallback } from 'react'
import { Folder } from 'lucide-react'
import { useGalleryStore } from '@renderer/stores/useGalleryStore'
import {
  useLocalThumbnailStore,
  buildLocalThumbnailKey
} from '@renderer/stores/useLocalThumbnailStore'
import { FolderCountBadge } from './FolderCountBadge'
import { useT } from '@renderer/i18n'
import type { IpcResult } from '@shared/types/ipc'
import type { LocalFolderPreview } from '@shared/types/gallery'

/** 미리보기가 없을 때의 폴더 글리프(이모지 대신 lucide, 기준선 #16). */
function FolderGlyph({ size }: { size: number }): React.JSX.Element {
  return (
    <Folder
      aria-hidden
      className="fill-amber-400/25 text-amber-500"
      strokeWidth={1.5}
      style={{ width: Math.round(size * 0.4), height: Math.round(size * 0.4) }}
    />
  )
}

interface LocalFolderThumbnailProps {
  folderPath: string
  size?: number
}

export function LocalFolderThumbnail({
  folderPath,
  size = 150
}: LocalFolderThumbnailProps): React.JSX.Element {
  const previewState = useGalleryStore((s) => s.localFolderPreviews[folderPath])
  const setPending = useGalleryStore((s) => s.setLocalPending)
  const setResolved = useGalleryStore((s) => s.setLocalResolved)
  const setError = useGalleryStore((s) => s.setLocalError)

  const ref = useRef<HTMLDivElement>(null)
  const requestedRef = useRef(false)

  const fetchPreview = useCallback(async () => {
    if (requestedRef.current) return
    requestedRef.current = true
    setPending(folderPath)
    try {
      const result = await window.api.invoke<IpcResult<LocalFolderPreview | null>>(
        'gallery:localFolderPreview',
        { localPath: folderPath }
      )
      if (result.success) {
        setResolved(folderPath, result.data)
      } else {
        setError(folderPath, result.error)
      }
    } catch (err) {
      setError(folderPath, err instanceof Error ? err.message : String(err))
    }
  }, [folderPath, setPending, setResolved, setError])

  useEffect(() => {
    if (previewState) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !requestedRef.current) {
          fetchPreview()
          observer.disconnect()
        }
      },
      { threshold: 0.1 }
    )
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [previewState, fetchPreview])

  useEffect(() => {
    requestedRef.current = false
  }, [folderPath])

  const preview = previewState && previewState.status === 'resolved' ? previewState.preview : null

  return (
    <div ref={ref} className="flex h-full w-full items-center justify-center">
      {preview ? (
        <LocalFolderPreviewImage preview={preview} folderPath={folderPath} size={size} />
      ) : (
        <FolderGlyph size={size} />
      )}
    </div>
  )
}

interface PreviewImageProps {
  folderPath: string
  preview: LocalFolderPreview
  size: number
}

function LocalFolderPreviewImage({
  folderPath,
  preview,
  size
}: PreviewImageProps): React.JSX.Element {
  const cacheKey = buildLocalThumbnailKey(preview.path, preview.size, preview.modifiedAt)
  const thumbnailData = useLocalThumbnailStore((s) => s.thumbnails[cacheKey])
  const t = useT()
  const requestedRef = useRef(false)

  useEffect(() => {
    if (thumbnailData || requestedRef.current) return
    requestedRef.current = true
    window.api.invoke('localThumbnail:request', {
      localPath: preview.path,
      fileSize: preview.size,
      modifiedAt: preview.modifiedAt
    })
  }, [preview.path, preview.size, preview.modifiedAt, thumbnailData])

  useEffect(() => {
    requestedRef.current = false
  }, [cacheKey])

  if (thumbnailData) {
    return (
      <div className="relative flex h-full w-full items-center justify-center">
        <img
          src={thumbnailData.dataUrl}
          alt={t('preview.folderAlt', { path: folderPath })}
          className="tile-img h-full w-full object-cover"
          loading="lazy"
        />
        <span
          className="absolute bottom-1.5 left-1.5 flex h-6 w-6 items-center justify-center rounded-md bg-[var(--sf)]/90 shadow-sm"
          aria-hidden
        >
          <Folder className="h-3.5 w-3.5 fill-amber-400/30 text-amber-500" />
        </span>
        <FolderCountBadge count={preview.itemCount} />
      </div>
    )
  }

  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <FolderGlyph size={size} />
      <FolderCountBadge count={preview.itemCount} />
    </div>
  )
}
