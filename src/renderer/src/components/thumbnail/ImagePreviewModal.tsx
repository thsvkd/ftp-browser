import { useEffect, useState, useRef } from 'react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useThumbnailStore } from '@renderer/stores/useThumbnailStore'
import { generateCacheKeyRenderer } from '@renderer/lib/cacheKey'
import type { FtpFileEntry } from '@shared/types/ftp'
import type { IpcResult } from '@shared/types/ipc'

interface ImagePreviewModalProps {
  entry: FtpFileEntry
  onClose: () => void
}

export function ImagePreviewModal({ entry, onClose }: ImagePreviewModalProps): React.JSX.Element {
  const host = useFtpStore((s) => s.host)
  const port = useFtpStore((s) => s.port)
  const currentPath = useFtpStore((s) => s.currentPath)
  const remotePath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`
  const cacheKey = generateCacheKeyRenderer(host, port, remotePath, entry.size, entry.modifiedAt)
  const thumbnailData = useThumbnailStore((s) => s.thumbnails[cacheKey])

  const [fullImageUrl, setFullImageUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortedRef = useRef(false)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // 모달이 열리면 바로 원본 이미지 다운로드 시작
  useEffect(() => {
    abortedRef.current = false
    setLoading(true)
    setError(null)

    window.api
      .invoke<IpcResult<string>>('ftp:downloadPreview', {
        remotePath,
        fileSize: entry.size,
        modifiedAt: entry.modifiedAt
      })
      .then((result) => {
        if (abortedRef.current) return
        if (result.success) {
          setFullImageUrl(result.data)
        } else {
          setError(result.error)
        }
      })
      .catch((err) => {
        if (abortedRef.current) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!abortedRef.current) setLoading(false)
      })

    return () => {
      abortedRef.current = true
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const imageUrl = fullImageUrl || thumbnailData?.dataUrl

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] max-w-[90vw] rounded-lg bg-white p-2 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="absolute -right-2 -top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-gray-800 text-sm text-white hover:bg-gray-600"
          onClick={onClose}
        >
          x
        </button>

        <div className="flex flex-col items-center">
          {imageUrl ? (
            <div className="relative">
              <img
                src={imageUrl}
                alt={entry.name}
                className="max-h-[80vh] max-w-[85vw] rounded object-contain"
              />
              {loading && !fullImageUrl && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="rounded-full bg-black/50 px-3 py-1 text-sm text-white">
                    Loading...
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-64 w-64 items-center justify-center text-gray-400">
              {loading ? 'Loading...' : error ? `Error: ${error}` : 'No preview available'}
            </div>
          )}
          <div className="mt-2 text-sm text-gray-600">
            <span className="font-medium">{entry.name}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
