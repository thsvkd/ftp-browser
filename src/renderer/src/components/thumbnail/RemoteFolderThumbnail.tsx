import { useEffect, useRef, useCallback } from 'react'
import { Folder } from 'lucide-react'
import { useGalleryStore } from '@renderer/stores/useGalleryStore'
import { useThumbnailStore } from '@renderer/stores/useThumbnailStore'
import { generateCacheKeyRenderer } from '@renderer/lib/cacheKey'
import { FolderCountBadge } from './FolderCountBadge'
import { useT } from '@renderer/i18n'
import { usePaneId } from '@renderer/components/explorer/paneContext'
import type { IpcResult } from '@shared/types/ipc'
import type { RemoteFolderPreview } from '@shared/types/gallery'
import type { ConnKey } from '@shared/connKey'

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

interface RemoteFolderThumbnailProps {
  /** 그 폴더의 연결. 미리보기 요청·스토어 키·안쪽 이미지 썸네일이 그 연결의 것이다 */
  server: ConnKey
  folderPath: string
  size?: number
}

export function RemoteFolderThumbnail({
  server,
  folderPath,
  size = 150
}: RemoteFolderThumbnailProps): React.JSX.Element {
  // 같은 경로라도 연결마다 다른 폴더다
  const storeKey = `${server}|${folderPath}`
  const previewState = useGalleryStore((s) => s.remoteFolderPreviews[storeKey])
  const setPending = useGalleryStore((s) => s.setRemotePending)
  const setResolved = useGalleryStore((s) => s.setRemoteResolved)
  const setError = useGalleryStore((s) => s.setRemoteError)

  // 이 타일이 있는 패널의 뷰어(split-view P2)
  const viewerId = usePaneId()

  const ref = useRef<HTMLDivElement>(null)
  const requestedRef = useRef(false)

  const fetchPreview = useCallback(async () => {
    if (requestedRef.current) return
    requestedRef.current = true
    setPending(storeKey)
    // 이 요청이 쓴 대기 항목. 답이 올 때 항목이 바뀌었으면(clearRemote로 지워졌거나 다른 요청이 덮었다)
    // 그 답은 낡았으니 쓰지 않는다. 쓰면 좌우 바꾸기·이동으로 취소된 옛 뷰어의 'Cancelled'가 새 뷰어로
    // 다시 요청할 타일을 오류로 묶는다(split-view P17).
    const mine = useGalleryStore.getState().remoteFolderPreviews[storeKey]
    const current = (): boolean =>
      useGalleryStore.getState().remoteFolderPreviews[storeKey] === mine
    try {
      const result = await window.api.invoke<IpcResult<RemoteFolderPreview | null>>(
        'gallery:remoteFolderPreview',
        server,
        { remotePath: folderPath, viewerId }
      )
      if (!current()) return
      if (result.success) {
        setResolved(storeKey, result.data)
      } else {
        setError(storeKey, result.error)
      }
    } catch (err) {
      if (current()) setError(storeKey, err instanceof Error ? err.message : String(err))
    }
  }, [server, folderPath, viewerId, storeKey, setPending, setResolved, setError])

  useEffect(() => {
    if (previewState) return
    // 항목이 없으면 (다시) 요청한다: 같은 서버의 다른 패널이 이동하며 clearRemote로 지웠을 수 있다(P17).
    requestedRef.current = false

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
  }, [storeKey])

  const preview = previewState && previewState.status === 'resolved' ? previewState.preview : null

  return (
    <div ref={ref} className="flex h-full w-full items-center justify-center">
      {preview ? (
        <RemoteFolderPreviewImage
          server={server}
          folderPath={folderPath}
          preview={preview}
          size={size}
        />
      ) : (
        <FolderGlyph size={size} />
      )}
    </div>
  )
}

interface PreviewImageProps {
  server: ConnKey
  folderPath: string
  preview: RemoteFolderPreview
  size: number
}

function RemoteFolderPreviewImage({
  server,
  folderPath,
  preview,
  size
}: PreviewImageProps): React.JSX.Element {
  const innerPath = folderPath === '/' ? `/${preview.name}` : `${folderPath}/${preview.name}`
  const cacheKey = generateCacheKeyRenderer(server, innerPath, preview.size, preview.modifiedAt)
  const thumbnailData = useThumbnailStore((s) => s.thumbnails[cacheKey])
  const t = useT()
  const requestedRef = useRef(false)

  useEffect(() => {
    if (thumbnailData || requestedRef.current) return
    requestedRef.current = true
    window.api.invoke('thumbnail:request', server, {
      remotePath: innerPath,
      fileName: preview.name,
      fileSize: preview.size,
      modifiedAt: preview.modifiedAt,
      priority: 1
    })
  }, [server, innerPath, preview.name, preview.size, preview.modifiedAt, thumbnailData])

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

  // Loading state — show folder icon while inner thumbnail is downloading
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <FolderGlyph size={size} />
      <FolderCountBadge count={preview.itemCount} />
    </div>
  )
}
