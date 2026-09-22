// Explorer/Finder-style type-to-select with Korean initial-consonant (초성) matching.
//
// Chromium disables the IME while a non-editable element has focus, so Korean
// keystrokes arrive as their 2-beolsik Latin keys ('r' for ㄱ). We therefore
// compare against each name's initials spelled as those keys: "사진" → "tw".

// 2-beolsik key for each of the 19 initial consonants, in Unicode order.
// Double consonants use the unshifted key so Shift/CapsLock never matter.
const INITIAL_KEYS = 'rrseefaqqttdwwczxvg'
const JAMO_INITIALS = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'

const SYLLABLE_START = 0xac00
const SYLLABLE_END = 0xd7a3
const SYLLABLES_PER_INITIAL = 588 // 21 vowels × 28 finals

/** Name with every Hangul syllable replaced by its initial's key, lower-cased. */
export function toInitialKeys(name: string): string {
  let out = ''
  for (const ch of name.toLowerCase()) {
    const code = ch.charCodeAt(0)
    out +=
      code >= SYLLABLE_START && code <= SYLLABLE_END
        ? INITIAL_KEYS[Math.floor((code - SYLLABLE_START) / SYLLABLES_PER_INITIAL)]
        : ch
  }
  return out
}

/** Normalise one typed character: a jamo consonant (if the IME did deliver one) becomes its key. */
export function normalizeTypedChar(ch: string): string {
  const i = JAMO_INITIALS.indexOf(ch)
  return i >= 0 ? INITIAL_KEYS[i] : ch.toLowerCase()
}

export function matchesTypeAhead(name: string, query: string): boolean {
  return name.toLowerCase().startsWith(query) || toInitialKeys(name).startsWith(query)
}

/** Printable single character with no command modifier — i.e. a type-ahead keystroke. */
export function isTypeAheadKey(e: React.KeyboardEvent): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
}

/** Same order every file view renders: directories first, then by name. */
export function sortForDisplay<T extends { name: string; type: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1
    if (a.type !== 'directory' && b.type === 'directory') return 1
    return a.name.localeCompare(b.name)
  })
}

export const TYPE_AHEAD_RESET_MS = 1000
