import { useLayoutEffect, useState } from 'react'

/**
 * Live `clientWidth` of the referenced element (null until first measured).
 * State-backed so layout derived from it re-renders when the window or panel resizes.
 */
export function useElementWidth(ref: React.RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    // Measure before first paint instead of waiting for the observer's first callback.
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [ref])

  return width
}
