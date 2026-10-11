import { useEffect, useRef, useCallback } from 'react'
import {
  useLocalThumbnailStore,
  buildLocalThumbnailKey
} from '@renderer/stores/useLocalThumbnailStore'

import { ThumbFace } from './ThumbnailImage'

interface LocalThumbnailImageProps {
  localPath: string
  fileSize: number
  modifiedAt: string
  /** "느린 응답" 배지를 보일지 */
  showSlow?: boolean
}

export function LocalThumbnailImage({
  localPath,
  fileSize,
  modifiedAt,
  showSlow = true
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

  const retry = (): void => {
    clearError(cacheKey)
    requestedRef.current = false
    requestThumbnail()
  }

  return (
    <div ref={ref} className="h-full w-full">
      <ThumbFace
        url={thumbnailData?.dataUrl}
        error={thumbnailError}
        onRetry={retry}
        showSlow={showSlow}
      />
    </div>
  )
}
