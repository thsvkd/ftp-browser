import { useRef } from 'react'
import {
  isTypeAheadKey,
  matchesTypeAhead,
  normalizeTypedChar,
  TYPE_AHEAD_RESET_MS
} from '@renderer/lib/typeAhead'

/**
 * Returns a keydown handler that accumulates typed characters (reset after a
 * pause) and selects the first name, in display order, that matches.
 * Returns true when the key was consumed.
 */
export function useTypeAhead(
  getNames: () => string[],
  select: (name: string) => void
): (e: React.KeyboardEvent) => boolean {
  const buffer = useRef({ query: '', at: 0 })

  return (e) => {
    if (!isTypeAheadKey(e)) return false
    const now = Date.now()
    const prev = now - buffer.current.at > TYPE_AHEAD_RESET_MS ? '' : buffer.current.query
    const query = prev + normalizeTypedChar(e.key)
    buffer.current = { query, at: now }
    e.preventDefault()
    const match = getNames().find((name) => matchesTypeAhead(name, query))
    if (match) select(match)
    return true
  }
}
