import { useThumbnailStore } from '@renderer/stores/useThumbnailStore'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { generateCacheKeyRenderer } from '@renderer/lib/cacheKey'
import { useT } from '@renderer/i18n'
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
  const t = useT()

  // 요청은 FileGridView가 보이는 행 단위 배치로 보낸다. 여기서는 ↻ 재시도만 직접 요청한다.
  const retry = (): void => {
    clearError(cacheKey)
    window.api.invoke('thumbnail:request', {
      remotePath,
      fileName: entry.name,
      fileSize: entry.size,
      modifiedAt: entry.modifiedAt,
      priority: 0
    })
  }

  if (thumbnailData) {
    return (
      <div className="flex h-full w-full items-center justify-center">
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
        className="flex h-full w-full cursor-pointer items-center justify-center rounded bg-gray-100 text-xs text-gray-400 hover:bg-gray-200"
        onClick={retry}
        title={t('thumbnail.retry', { reason: thumbnailError })}
      >
        ↻
      </div>
    )
  }

  return (
    <div className="flex h-full w-full items-center justify-center rounded bg-gray-100 text-2xl text-gray-300" />
  )
}
