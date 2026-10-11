import { useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMarqueeSelection, type MarqueeRect } from '@renderer/hooks/useMarqueeSelection'
import { ROW } from '@renderer/lib/explorerLayout'
import type { ViewProps } from './FileGrid'
import { Row } from './Row'

/** 가상화 리스트(기준선 #11): 보이는 행만 그린다. 열 머리(`ListHeader`)는 목록 밖 위에 있다. */
export function FileList({
  items,
  scrollRef,
  itemProps,
  setSelection,
  getSelection
}: ViewProps): React.JSX.Element {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 8,
    paddingEnd: 12
  })

  const pathsInRect = useCallback(
    (rect: MarqueeRect): string[] => {
      const first = Math.max(0, Math.floor(rect.top / ROW))
      const last = Math.min(items.length - 1, Math.floor(rect.bottom / ROW))
      return items.slice(first, last + 1).map((e) => e.path)
    },
    [items]
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
      {virtualizer.getVirtualItems().map((row) => {
        const entry = items[row.index]
        return entry ? <Row key={entry.path} {...itemProps(entry)} top={row.start} /> : null
      })}
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
