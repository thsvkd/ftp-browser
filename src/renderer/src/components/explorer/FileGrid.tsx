import { useCallback, useEffect, useLayoutEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMarqueeSelection, type MarqueeRect } from '@renderer/hooks/useMarqueeSelection'
import { generateCacheKeyRenderer } from '@renderer/lib/cacheKey'
import type { ExplorerEntry } from '@renderer/lib/explorerEntry'
import { GAP, LABEL_H, PAD } from '@renderer/lib/explorerLayout'
import { itemIndicesInRect, type GridLayout } from '@renderer/lib/gridGeometry'
import { currentPlatform, isZoomModifier } from '@renderer/lib/platform'
import { viewportThumbnailTargets } from '@renderer/lib/thumbnailViewport'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useThumbnailStore } from '@renderer/stores/useThumbnailStore'
import { Tile } from './Tile'
import type { ItemProps } from './useItem'

/** Ctrl+휠·Ctrl+= / Ctrl+− 한 번에 바뀌는 타일 크기(px) */
export const ZOOM_STEP = 16

export interface ViewProps {
  items: ExplorerEntry[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  itemProps: (entry: ExplorerEntry) => ItemProps
  /** 마퀴가 고른 경로로 선택을 바꾼다 */
  setSelection: (paths: string[]) => void
  getSelection: () => Set<string>
}

/**
 * 가상화 그리드. 원격이면 보이는 행 ± 한 화면의 이미지 썸네일을 가까운 순 배치 하나로 요청한다
 * (thumbnail-viewport-priority). Ctrl·Cmd+휠은 타일 크기를 바꾼다(네이티브 non-passive 리스너).
 */
export function FileGrid({
  items,
  scrollRef,
  itemProps,
  setSelection,
  getSelection,
  layout,
  remote
}: ViewProps & { layout: GridLayout; remote: boolean }): React.JSX.Element {
  const { cols, cellWidth, imageHeight, rowHeight } = layout
  const host = useFtpStore((s) => s.host)
  const port = useFtpStore((s) => s.port)
  const rowCount = Math.ceil(items.length / cols)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 3,
    paddingStart: PAD,
    paddingEnd: PAD
  })
  useLayoutEffect(() => virtualizer.measure(), [rowHeight, cols, virtualizer])

  // range는 getVirtualItems() 안에서 계산되므로 그 뒤에 읽는다(보이는 행만, overscan 제외).
  const rows = virtualizer.getVirtualItems()
  const visibleStart = virtualizer.range?.startIndex
  const visibleEnd = virtualizer.range?.endIndex

  // 보이는 행 ± 한 화면 안의 이미지를 배치 하나로 요청한다. main은 직전 배치를 교체한다.
  useEffect(() => {
    if (!remote || visibleStart === undefined || visibleEnd === undefined) return
    const { thumbnails, errors, clearError } = useThumbnailStore.getState()
    const inWindow = viewportThumbnailTargets(
      items,
      cols,
      { startIndex: visibleStart, endIndex: visibleEnd },
      visibleEnd - visibleStart + 1
    ).map(({ entry, priority }) => ({
      key: generateCacheKeyRenderer(host, port, entry.path, entry.size, entry.modifiedAt),
      request: {
        remotePath: entry.path,
        fileName: entry.name,
        fileSize: entry.size,
        modifiedAt: entry.modifiedAt,
        priority
      }
    }))
    const windowKeys = new Set(inWindow.map((x) => x.key))
    // 받은 것은 다시 보내지 않고, 실패한 것은 창 안에 있는 동안 재시도하지 않는다.
    const requests = inWindow
      .filter((x) => !thumbnails[x.key] && !errors[x.key])
      .map((x) => x.request)
    // 창을 벗어난 실패 항목은 에러를 지워, 다시 보일 때 재요청되게 한다.
    for (const key of Object.keys(errors)) if (!windowKeys.has(key)) clearError(key)
    window.api.invoke('thumbnail:requestBatch', requests)
  }, [remote, visibleStart, visibleEnd, items, cols, host, port])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!isZoomModifier(e, currentPlatform())) return
      e.preventDefault()
      useSettingsStore.getState().adjustTileSize(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [scrollRef])

  const pathsInRect = useCallback(
    (rect: MarqueeRect): string[] =>
      itemIndicesInRect(
        { ...rect, top: rect.top - PAD, bottom: rect.bottom - PAD },
        items.length,
        cols,
        cellWidth,
        GAP,
        PAD,
        0,
        imageHeight + LABEL_H
      ).map((i) => items[i].path),
    [items, cols, cellWidth, imageHeight]
  )
  const { marquee, onMouseDown } = useMarqueeSelection({
    scrollRef,
    namesInRect: pathsInRect,
    setSelection,
    getSelection
  })

  return (
    <div
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize(), minHeight: '100%' }}
      onMouseDown={onMouseDown}
    >
      {rows.map((row) =>
        items
          .slice(row.index * cols, row.index * cols + cols)
          .map((entry, c) => (
            <Tile
              key={entry.path}
              {...itemProps(entry)}
              x={PAD + c * (cellWidth + GAP)}
              y={row.start}
              width={cellWidth}
              imageHeight={imageHeight}
            />
          ))
      )}
      {marquee && (
        <div
          className="pointer-events-none absolute z-10 rounded-[4px] border border-[var(--ac)] bg-[color-mix(in_srgb,var(--ac)_14%,transparent)]"
          style={{
            left: marquee.left,
            top: marquee.top,
            width: marquee.width,
            height: marquee.height
          }}
        />
      )}
    </div>
  )
}
