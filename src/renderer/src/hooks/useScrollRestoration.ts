import { useEffect, useLayoutEffect } from 'react'

/** Cap on remembered positions so a long browsing session can't grow unbounded. */
const MAX_ENTRIES = 300

/**
 * Remembers a scroll container's vertical position per `key` (e.g. directory
 * path) and restores it when the key returns. The store must live outside the
 * component (module scope) because the file views remount on navigation.
 */
export function useScrollRestoration(
  scrollRef: React.RefObject<HTMLElement | null>,
  key: string,
  store: Map<string, number>
): void {
  // Restore before paint so there is no visible jump from the top.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = store.get(key) ?? 0
  }, [key, scrollRef, store])

  // Persist the latest position as the user scrolls.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      // Evict the oldest entry (Map preserves insertion order) before adding a new key.
      if (!store.has(key) && store.size >= MAX_ENTRIES) {
        const oldest = store.keys().next().value
        if (oldest !== undefined) store.delete(oldest)
      }
      store.set(key, el.scrollTop)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [key, scrollRef, store])
}
