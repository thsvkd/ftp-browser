import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, PackageCheck, PackagePlus, X } from 'lucide-react'
import { useEscapeKey } from '@renderer/hooks/useEscapeKey'
import { useT } from '@renderer/i18n'
import { locKey, type ExplorerEntry } from '@renderer/lib/explorerEntry'
import { cn, formatBytes, formatDate } from '@renderer/lib/utils'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { EntryThumb } from '@renderer/components/thumbnail/EntryThumb'
import { isVideoFile } from '@shared/constants'
import type { IpcResult } from '@shared/types/ipc'

interface Loaded {
  key: string
  url: string | null
  error: string | null
}

/** 큰 미리 보기: 원격은 `ftp:downloadPreview`, 로컬은 `local:preview`(CSP 때문에 data URL, D22). */
function usePreview(entry: ExplorerEntry): Loaded | null {
  const key = `${entry.side}|${entry.server ?? ''}|${entry.path}|${entry.size}|${entry.modifiedAt}`
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  useEffect(() => {
    // 영상은 확장자로 판정한다(P2): entry.isImage는 이미지에만 참이다.
    if (!entry.isImage && !isVideoFile(entry.name)) return
    let live = true
    const request =
      entry.side === 'remote'
        ? window.api.invoke<IpcResult<string>>('ftp:downloadPreview', entry.server, {
            remotePath: entry.path,
            fileSize: entry.size,
            modifiedAt: entry.modifiedAt
          })
        : window.api.invoke<IpcResult<string>>('local:preview', entry.path)
    request
      .then((r) => {
        if (live)
          setLoaded(
            r.success
              ? { key, url: r.data, error: null }
              : { key, url: null, error: r.error ?? null }
          )
      })
      .catch((err) => {
        if (live)
          setLoaded({ key, url: null, error: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      live = false
    }
  }, [
    key,
    entry.isImage,
    entry.name,
    entry.side,
    entry.server,
    entry.path,
    entry.size,
    entry.modifiedAt
  ])
  return loaded?.key === key ? loaded : null
}

/**
 * 라이트박스(Space·Enter·더블클릭, D22). ←/→·Home/End로 넘기고 Esc·Space·Enter로 닫는다.
 * Shift+S는 선반에 담기/빼기. 아래 필름 스트립은 앞뒤 30장.
 */
export function Lightbox({
  items,
  index,
  onIndex,
  onClose
}: {
  items: ExplorerEntry[]
  index: number
  onIndex: (i: number) => void
  onClose: () => void
}): React.JSX.Element | null {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const entry = items[index]
  const shelfKeys = useShelfStore((s) => s.items.map((i) => locKey(i.entry)).join('\n'))
  const shelved = new Set(shelfKeys.split('\n'))
  const preview = usePreview(entry)
  useEscapeKey(onClose)
  useEffect(() => ref.current?.focus(), [])
  useEffect(() => {
    stripRef.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView?.({ inline: 'center', block: 'nearest' })
  }, [index])
  if (!entry) return null

  const go = (d: number): void => onIndex(Math.max(0, Math.min(items.length - 1, index + d)))
  // P2: 영상 판정은 확장자로 한다. 카테고리 video 목록(mkv·avi 등)과는 갈린다(함정 A).
  const video = isVideoFile(entry.name)
  const isShelved = shelved.has(locKey(entry))
  const toggleShelf = (): void => {
    const shelf = useShelfStore.getState()
    if (isShelved) shelf.remove([locKey(entry)])
    else shelf.add([entry])
  }
  const lo = Math.max(0, index - 30)

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={t('lightbox.label', { name: entry.name })}
      tabIndex={-1}
      className="fade fixed inset-0 z-[65] flex flex-col bg-[#0B0F0E]/95 text-white outline-none"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        // 영상 컨트롤에 포커스가 있으면 가로채지 않고 그대로 넘긴다(P6·함정 C). 아니면 기존 닫기·넘김.
        if (e.target instanceof Element && e.target.closest('video')) return
        if (e.key === 'ArrowRight') go(1)
        else if (e.key === 'ArrowLeft') go(-1)
        else if (e.key === 'Home') onIndex(0)
        else if (e.key === 'End') onIndex(items.length - 1)
        else if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          onClose()
        } else if (e.shiftKey && e.key === 'S') toggleShelf()
      }}
    >
      <div className="flex h-14 shrink-0 items-center gap-3 px-5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{entry.name}</div>
          <div className="mono truncate text-[11px] text-white/55">
            {formatBytes(entry.size)} · {formatDate(entry.modifiedAt)}
          </div>
        </div>
        <span className="mono text-[12px] text-white/55">
          {t('lightbox.position', { number: index + 1, total: items.length })}
        </span>
        <button
          onClick={toggleShelf}
          aria-pressed={isShelved}
          aria-keyshortcuts="Shift+S"
          className={cn(
            'flex h-9 items-center gap-2 rounded-full px-4 text-[13px] font-semibold',
            isShelved ? 'bg-white/10 text-[#F2B95A]' : 'bg-[#F2B95A] text-[#231600]'
          )}
        >
          {isShelved ? (
            <PackageCheck className="h-4 w-4" aria-hidden />
          ) : (
            <PackagePlus className="h-4 w-4" aria-hidden />
          )}
          {t(isShelved ? 'menu.removeFromShelf' : 'menu.addToShelf')}
        </button>
        <button
          onClick={onClose}
          aria-label={t('common.close')}
          className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/10"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-16">
        {preview?.url && video ? (
          <video
            key={entry.path}
            src={preview.url}
            controls
            autoPlay
            muted
            className="fade max-h-full max-w-full drop-shadow-2xl"
          />
        ) : preview?.url ? (
          <img
            key={entry.path}
            src={preview.url}
            alt={entry.name}
            className="fade h-full w-full object-contain drop-shadow-2xl"
          />
        ) : entry.isImage && !preview ? (
          <div className="h-[60%] w-[60%] animate-pulse rounded-lg bg-white/5" />
        ) : (
          <div className="flex w-[360px] flex-col items-center gap-4 rounded-2xl bg-white/5 p-8 text-center">
            <div className="h-24 w-24 [&_svg]:text-white/70">
              <EntryThumb entry={entry} glyph="h-16 w-16" request />
            </div>
            <p className="text-[13px] text-white/60">
              {preview?.error ? t('preview.failed', { reason: preview.error }) : t('preview.none')}
            </p>
          </div>
        )}
        <button
          onClick={() => go(-1)}
          disabled={index === 0}
          aria-label={t('lightbox.previous')}
          className="absolute left-4 flex h-11 w-11 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-20"
        >
          <ChevronLeft className="h-6 w-6" aria-hidden />
        </button>
        <button
          onClick={() => go(1)}
          disabled={index === items.length - 1}
          aria-label={t('lightbox.next')}
          className="absolute right-4 flex h-11 w-11 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-20"
        >
          <ChevronRight className="h-6 w-6" aria-hidden />
        </button>
      </div>
      <div
        ref={stripRef}
        className="scroll flex h-[84px] shrink-0 gap-1.5 overflow-x-auto px-5 py-3"
      >
        {items.slice(lo, index + 31).map((s, i) => (
          <button
            key={s.path}
            aria-current={lo + i === index}
            aria-label={s.name}
            onClick={() => onIndex(lo + i)}
            className={cn(
              'relative h-full w-[80px] shrink-0 overflow-hidden rounded-md bg-white/5 transition-opacity',
              lo + i === index ? 'opacity-100 ring-2 ring-[#F2B95A]' : 'opacity-50 hover:opacity-90'
            )}
          >
            <EntryThumb entry={s} glyph="h-5 w-5" showSlow={false} request />
            {shelved.has(locKey(s)) && (
              <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-[#F2B95A]" />
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
