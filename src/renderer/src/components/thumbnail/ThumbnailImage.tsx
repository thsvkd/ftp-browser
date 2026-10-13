import { useEffect, useState } from 'react'
import { Clock, RotateCcw } from 'lucide-react'
import { useThumbnailStore } from '@renderer/stores/useThumbnailStore'
import { generateCacheKeyRenderer } from '@renderer/lib/cacheKey'
import type { ExplorerEntry } from '@renderer/lib/explorerEntry'
import { useT } from '@renderer/i18n'

/** 대기가 이만큼 길어지면 "느린 응답"을 보인다. */
const SLOW_MS = 3000

interface ThumbnailImageProps {
  /** `server`는 그 항목의 연결. 키·요청이 그 연결의 것이다(원격 항목은 늘 갖는다) */
  entry: Pick<ExplorerEntry, 'name' | 'size' | 'modifiedAt' | 'server'>
  /** 항목의 원격 경로(D30) */
  remotePath: string
  /** 그리드 밖(선반·정보·라이트박스): 스토어에 없으면 마운트 때 단건 요청(priority 1)을 보낸다. */
  request?: boolean
  /** "느린 응답" 배지를 보일지 */
  showSlow?: boolean
}

function Pending({ showSlow }: { showSlow: boolean }): React.JSX.Element {
  const t = useT()
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div role="img" aria-label={t('thumbnail.loading')} className="shimmer relative h-full w-full">
      {slow && showSlow && (
        <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 text-[10px] font-medium text-white">
          <Clock className="h-3 w-3" aria-hidden /> {t('thumbnail.slow')}
        </span>
      )}
    </div>
  )
}

/** 탐색기 썸네일의 얼굴: 이미지(4:3 채우기)·대기·오류(누르면 재시도). 원격·로컬이 함께 쓴다. */
export function ThumbFace({
  url,
  error,
  onRetry,
  showSlow = true
}: {
  url?: string
  error?: string
  onRetry: () => void
  showSlow?: boolean
}): React.JSX.Element {
  const t = useT()
  if (url)
    return (
      <img src={url} alt="" draggable={false} className="tile-img h-full w-full object-cover" />
    )
  if (error)
    return (
      <button
        type="button"
        data-nomarquee
        onClick={(e) => {
          e.stopPropagation()
          onRetry()
        }}
        title={t('thumbnail.retry', { reason: error })}
        aria-label={t('thumbnail.retry', { reason: error })}
        className="flex h-full w-full items-center justify-center text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]"
      >
        <RotateCcw className="h-5 w-5" aria-hidden />
      </button>
    )
  return <Pending showSlow={showSlow} />
}

export function ThumbnailImage({
  entry,
  remotePath,
  request = false,
  showSlow = true
}: ThumbnailImageProps): React.JSX.Element {
  const server = entry.server ?? ''
  const cacheKey = generateCacheKeyRenderer(server, remotePath, entry.size, entry.modifiedAt)

  const thumbnailData = useThumbnailStore((s) => s.thumbnails[cacheKey])
  const thumbnailError = useThumbnailStore((s) => s.errors[cacheKey])
  const clearError = useThumbnailStore((s) => s.clearError)

  const send = (priority: number): void => {
    window.api.invoke('thumbnail:request', server, {
      remotePath,
      fileName: entry.name,
      fileSize: entry.size,
      modifiedAt: entry.modifiedAt,
      priority
    })
  }

  // 그리드 안은 그리드가 보이는 행 단위 배치로 요청한다. 그리드 밖은 여기서 한 건만(D30).
  useEffect(() => {
    if (!request) return
    const { thumbnails, errors } = useThumbnailStore.getState()
    if (thumbnails[cacheKey] || errors[cacheKey]) return
    window.api.invoke('thumbnail:request', server, {
      remotePath,
      fileName: entry.name,
      fileSize: entry.size,
      modifiedAt: entry.modifiedAt,
      priority: 1
    })
  }, [request, cacheKey, server, remotePath, entry.name, entry.size, entry.modifiedAt])

  // ↻ 재시도는 직접 요청한다.
  const retry = (): void => {
    clearError(cacheKey)
    send(0)
  }

  return (
    <ThumbFace
      url={thumbnailData?.dataUrl}
      error={thumbnailError}
      onRetry={retry}
      showSlow={showSlow}
    />
  )
}
