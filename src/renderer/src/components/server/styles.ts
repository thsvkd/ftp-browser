import { cn } from '@renderer/lib/utils'

const TONES = {
  primary: 'bg-[var(--ac)] text-[var(--acx)] shadow-sm hover:brightness-110',
  secondary: 'border border-[var(--bd2)] bg-[var(--sf)] text-[var(--tx)] hover:bg-[var(--hv)]',
  ghost: 'text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]',
  dangerGhost: 'text-[var(--dg)] hover:bg-[var(--dgw)]'
}

const SIZES = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3 text-[13px]',
  icon: 'h-7 w-7',
  iconSm: 'h-6 w-6'
}

/** Button classes shared by the connect bar, saved-servers list and server manager. */
export function btn(
  tone: keyof typeof TONES = 'secondary',
  size: keyof typeof SIZES = 'md',
  className?: string
): string {
  return cn(
    'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ac)] focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-45',
    TONES[tone],
    SIZES[size],
    className
  )
}

export const inputCls =
  'h-8 w-full min-w-0 rounded-md border border-[var(--bd2)] bg-[var(--sf)] px-2.5 text-[13px] text-[var(--tx)] placeholder:text-[var(--mu)] focus:border-[var(--ac)] focus:outline-none focus:ring-2 focus:ring-[var(--acw)] disabled:bg-[var(--sb)] disabled:text-[var(--mu)]'

/** Background of the active row in server lists. */
export const selectedCls = 'bg-[var(--acw)] text-[var(--tx)]'

/** lucide stroke width used throughout the server UI. */
export const STROKE = 1.75

const DOT_TONES = [
  'bg-sky-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-violet-500',
  'bg-teal-500',
  'bg-orange-500',
  'bg-slate-500'
]

/** A stable colour per server label, so a server keeps its dot across lists. */
export function dotTone(label: string): string {
  let h = 0
  for (const c of label) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return DOT_TONES[h % DOT_TONES.length]
}

/** Enter = submit, Esc = cancel/close. Leaves IME composition and Enter on buttons alone. */
export function onEnterEsc(h: { enter?: () => void; esc?: () => void }) {
  return (e: React.KeyboardEvent): void => {
    if (e.nativeEvent.isComposing) return
    const tag = (e.target as HTMLElement).tagName
    if (e.key === 'Enter' && h.enter && tag !== 'BUTTON' && tag !== 'TEXTAREA') {
      e.preventDefault()
      h.enter()
    } else if (e.key === 'Escape' && h.esc) {
      e.preventDefault()
      e.stopPropagation()
      h.esc()
    }
  }
}

/** Next index for ↑/↓/Home/End in a list, or null for any other key. */
export function arrowIndex(key: string, i: number, len: number): number | null {
  if (!len) return null
  if (key === 'ArrowDown') return Math.min(len - 1, i + 1)
  if (key === 'ArrowUp') return Math.max(0, i - 1)
  if (key === 'Home') return 0
  if (key === 'End') return len - 1
  return null
}
