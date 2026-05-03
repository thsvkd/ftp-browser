import { useEffect, useRef, useCallback } from 'react'
import {
  useLocalThumbnailStore,
  buildLocalThumbnailKey
} from '@renderer/stores/useLocalThumbnailStore'

interface LocalThumbnailImageProps {
  localPath: string
  fileSize: number
  modifiedAt: string
  alt: string
  size?: number
}

export function LocalThumbnailImage({
  localPath,
  fileSize,
  modifiedAt,
  alt,
  size = 150
}: LocalThumbnailImageProps): React.JSX.Element {
  const cacheKey = buildLocalThumbnailKey(localPath, fileSize, modifiedAt)
  const thumbnailData = useLocalThumbnailStore((s) => s.thumbnails[cacheKey])
  const thumbnailError = useLocalThumbnailStore((s) => s.errors[cacheKey])
  const clearError = useLocalThumbnailStore((s) => s.clearError)
  const ref = useRef<HTMLDivElement>(null)
  const requestedRef = useRef(false)

  const requestThumbnail = useCallback(() => {
    requestedRef.current = true
    window.api.invoke('localThumbnail:request', {
      localPath,
      fileSize,
      modifiedAt
    })
  }, [localPath, fileSize, modifiedAt])

  useEffect(() => {
    if (thumbnailData || requestedRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !requestedRef.current) {
          requestThumbnail()
          observer.disconnect()
        }
      },
      { threshold: 0.1 }
    )

    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [thumbnailData, requestThumbnail])

  useEffect(() => {
    requestedRef.current = false
  }, [cacheKey])

  if (thumbnailData) {
    return (
      <div
        ref={ref}
        className="flex items-center justify-center"
        style={{ width: size, maxHeight: size }}
      >
        <img
          src={thumbnailData.dataUrl}
          alt={alt}
          className="max-h-full max-w-full rounded object-contain"
          loading="lazy"
        />
      </div>
    )
  }

  if (thumbnailError) {
    return (
      <div
        ref={ref}
        className="flex cursor-pointer items-center justify-center rounded bg-gray-100 text-xs text-gray-400 hover:bg-gray-200"
        style={{ width: size, maxHeight: size }}
        onClick={() => {
          clearError(cacheKey)
          requestedRef.current = false
          requestThumbnail()
        }}
        title={`Error: ${thumbnailError}\nClick to retry`}
      >
        ↻
      </div>
    )
  }

  return (
    <div
      ref={ref}
      className="flex items-center justify-center rounded bg-gray-100 text-2xl text-gray-300"
      style={{ width: size, height: size, maxHeight: '100%' }}
    />
  )
}
