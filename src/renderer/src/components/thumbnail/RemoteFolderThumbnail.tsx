import { useEffect, useRef, useCallback } from 'react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useGalleryStore } from '@renderer/stores/useGalleryStore'
import { useThumbnailStore } from '@renderer/stores/useThumbnailStore'
import { generateCacheKeyRenderer } from '@renderer/lib/cacheKey'
import type { IpcResult } from '@shared/types/ipc'
import type { RemoteFolderPreview } from '@shared/types/gallery'

const FOLDER_ICON = '\u{1F4C1}'

interface RemoteFolderThumbnailProps {
  folderPath: string
  size?: number
}

export function RemoteFolderThumbnail({
  folderPath,
  size = 150
}: RemoteFolderThumbnailProps): React.JSX.Element {
  const host = useFtpStore((s) => s.host)
  const port = useFtpStore((s) => s.port)
  const previewState = useGalleryStore((s) => s.remoteFolderPreviews[folderPath])
  const setPending = useGalleryStore((s) => s.setRemotePending)
  const setResolved = useGalleryStore((s) => s.setRemoteResolved)
  const setError = useGalleryStore((s) => s.setRemoteError)

  const ref = useRef<HTMLDivElement>(null)
  const requestedRef = useRef(false)

  const fetchPreview = useCallback(async () => {
    if (requestedRef.current) return
    requestedRef.current = true
    setPending(folderPath)
    try {
      const result = await window.api.invoke<IpcResult<RemoteFolderPreview | null>>(
        'gallery:remoteFolderPreview',
        { remotePath: folderPath }
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
        <RemoteFolderPreviewImage
          folderPath={folderPath}
          preview={preview}
          host={host}
          port={port}
          size={size}
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center leading-none"
          style={{ fontSize: Math.round(size * 0.6) }}
        >
          {FOLDER_ICON}
        </div>
      )}
    </div>
  )
}

interface PreviewImageProps {
  folderPath: string
  preview: RemoteFolderPreview
  host: string
  port: number
  size: number
}

function RemoteFolderPreviewImage({
  folderPath,
  preview,
  host,
  port,
  size
}: PreviewImageProps): React.JSX.Element {
  const innerPath = folderPath === '/' ? `/${preview.name}` : `${folderPath}/${preview.name}`
  const cacheKey = generateCacheKeyRenderer(host, port, innerPath, preview.size, preview.modifiedAt)
  const thumbnailData = useThumbnailStore((s) => s.thumbnails[cacheKey])
  const requestedRef = useRef(false)

  useEffect(() => {
    if (thumbnailData || requestedRef.current) return
    requestedRef.current = true
    window.api.invoke('thumbnail:request', {
      remotePath: innerPath,
      fileName: preview.name,
      fileSize: preview.size,
      modifiedAt: preview.modifiedAt,
      priority: 1
    })
  }, [innerPath, preview.name, preview.size, preview.modifiedAt, thumbnailData])

  useEffect(() => {
    requestedRef.current = false
  }, [cacheKey])

  if (thumbnailData) {
    return (
      <div className="relative flex h-full w-full items-center justify-center">
        <img
          src={thumbnailData.dataUrl}
          alt={`${folderPath} preview`}
          className="h-full w-full rounded object-contain"
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

  // Loading state — show folder icon while inner thumbnail is downloading
  return (
    <div
      className="flex h-full w-full items-center justify-center leading-none"
      style={{ fontSize: Math.round(size * 0.6) }}
    >
      {FOLDER_ICON}
    </div>
  )
}
