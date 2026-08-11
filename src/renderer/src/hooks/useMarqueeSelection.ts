import { useCallback, useEffect, useRef, useState } from 'react'
import { currentPlatform, isToggleSelectModifier } from '@renderer/lib/platform'

/** Marquee rectangle in content (scroll) space, for rendering the overlay. */
export interface MarqueeBox {
  left: number
  top: number
  width: number
  height: number
}

/** Normalized content-space rect passed to the hit-test callback. */
export interface MarqueeRect {
  left: number
  top: number
  right: number
  bottom: number
}

interface Params {
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** Names of items whose cells intersect the given content-space rect. */
  namesInRect: (rect: MarqueeRect) => string[]
  /** Replace the current selection with these names. */
  setSelection: (names: string[]) => void
  /** Snapshot of the current selection, used as the base when a modifier is held. */
  getSelection: () => Set<string>
}

/**
 * Rubber-band (marquee) selection for a scrollable grid. A drag that starts on
 * empty space (not on an element marked `data-grid-cell`) draws a rectangle and
 * selects every intersecting item. Holding Shift, or the platform's selection
 * toggle modifier, adds to the existing selection instead of replacing it.
 */
export function useMarqueeSelection({
  scrollRef,
  namesInRect,
  setSelection,
  getSelection
}: Params): { marquee: MarqueeBox | null; onMouseDown: (e: React.MouseEvent) => void } {
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null)

  // Keep the latest callbacks so the window listeners never go stale mid-drag.
  // Synced in an effect (not during render) per the rules-of-hooks ref rule.
  const namesRef = useRef(namesInRect)
  const setRef = useRef(setSelection)
  const getRef = useRef(getSelection)
  useEffect(() => {
    namesRef.current = namesInRect
    setRef.current = setSelection
    getRef.current = getSelection
  })

  const onMouseDown = useCallback(
    (e: React.MouseEvent): void => {
      if (e.button !== 0) return
      const el = scrollRef.current
      if (!el) return
      // Starting on an item is a click/drag-and-drop, not a marquee.
      if ((e.target as HTMLElement).closest('[data-grid-cell]')) return

      const additive = isToggleSelectModifier(e, currentPlatform()) || e.shiftKey
      const base = additive ? new Set(getRef.current()) : new Set<string>()
      if (!additive) setRef.current([]) // plain click on empty space clears

      const containerRect = el.getBoundingClientRect()
      const toContent = (clientX: number, clientY: number): { x: number; y: number } => ({
        x: clientX - containerRect.left + el.scrollLeft,
        y: clientY - containerRect.top + el.scrollTop
      })
      const start = toContent(e.clientX, e.clientY)

      const onMove = (ev: MouseEvent): void => {
        const cur = toContent(ev.clientX, ev.clientY)
        const left = Math.min(start.x, cur.x)
        const top = Math.min(start.y, cur.y)
        const right = Math.max(start.x, cur.x)
        const bottom = Math.max(start.y, cur.y)
        setMarquee({ left, top, width: right - left, height: bottom - top })
        const names = namesRef.current({ left, top, right, bottom })
        setRef.current(additive ? [...base, ...names] : names)
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        setMarquee(null)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [scrollRef]
  )

  useEffect(() => () => setMarquee(null), [])

  return { marquee, onMouseDown }
}
