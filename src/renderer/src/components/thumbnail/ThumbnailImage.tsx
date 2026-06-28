import { useEffect, useRef, useCallback } from 'react'
import { useThumbnailStore } from '@renderer/stores/useThumbnailStore'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { generateCacheKeyRenderer } from '@renderer/lib/cacheKey'
import type { FtpFileEntry } from '@shared/types/ftp'

interface ThumbnailImageProps {
  entry: FtpFileEntry
}

export function ThumbnailImage({ entry }: ThumbnailImageProps): React.JSX.Element {
  const host = useFtpStore((s) => s.host)
  const port = useFtpStore((s) => s.port)
  const currentPath = useFtpStore((s) => s.currentPath)
  const remotePath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`
  const cacheKey = generateCacheKeyRenderer(host, port, remotePath, entry.size, entry.modifiedAt)

  const thumbnailData = useThumbnailStore((s) => s.thumbnails[cacheKey])
  const thumbnailError = useThumbnailStore((s) => s.errors[cacheKey])
  const clearError = useThumbnailStore((s) => s.clearError)
  const ref = useRef<HTMLDivElement>(null)
  const requestedRef = useRef(false)

  const requestThumbnail = useCallback(() => {
    requestedRef.current = true
    window.api.invoke('thumbnail:request', {
      remotePath,
      fileName: entry.name,
      fileSize: entry.size,
      modifiedAt: entry.modifiedAt,
      priority: 0
    })
  }, [remotePath, entry.name, entry.size, entry.modifiedAt])

  useEffect(() => {
    if (thumbnailData || requestedRef.current) return
    if (!entry.isImage) return

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
  }, [entry, remotePath, thumbnailData, requestThumbnail])

  // Reset requested flag when entry changes
  useEffect(() => {
    requestedRef.current = false
  }, [remotePath])

  if (thumbnailData) {
    return (
      <div ref={ref} className="flex h-full w-full items-center justify-center">
        <img
          src={thumbnailData.dataUrl}
          alt={entry.name}
          className="h-full w-full rounded object-contain"
          loading="lazy"
        />
      </div>
    )
  }

  // 에러 상태: 클릭으로 재시도 가능
  if (thumbnailError) {
    return (
      <div
        ref={ref}
        className="flex h-full w-full cursor-pointer items-center justify-center rounded bg-gray-100 text-xs text-gray-400 hover:bg-gray-200"
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
      className="flex h-full w-full items-center justify-center rounded bg-gray-100 text-2xl text-gray-300"
    />
  )
}
