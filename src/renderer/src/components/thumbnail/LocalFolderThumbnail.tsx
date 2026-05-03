import { useEffect, useRef, useCallback } from 'react'
import { useGalleryStore } from '@renderer/stores/useGalleryStore'
import {
  useLocalThumbnailStore,
  buildLocalThumbnailKey
} from '@renderer/stores/useLocalThumbnailStore'
import type { IpcResult } from '@shared/types/ipc'
import type { LocalFolderPreview } from '@shared/types/gallery'

const FOLDER_ICON = '\u{1F4C1}'

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
    <div
      ref={ref}
      className="flex items-center justify-center"
      style={{ width: size, maxHeight: size }}
    >
      {preview ? (
        <LocalFolderPreviewImage preview={preview} folderPath={folderPath} size={size} />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-3xl">{FOLDER_ICON}</div>
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
          alt={`${folderPath} preview`}
          className="max-h-full max-w-full rounded object-contain"
          loading="lazy"
        />
        <span
          className="absolute bottom-0 left-0 rounded-tr bg-gray-900/70 px-1 text-[10px] text-white"
          aria-hidden
        >
          {FOLDER_ICON}
        </span>
      </div>
    )
  }

  return (
    <div
      className="flex h-full w-full items-center justify-center text-3xl"
      style={{ minHeight: size / 2 }}
    >
      {FOLDER_ICON}
    </div>
  )
}
