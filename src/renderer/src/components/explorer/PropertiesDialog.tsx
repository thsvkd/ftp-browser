import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { useEscapeKey } from '@renderer/hooks/useEscapeKey'
import { useT } from '@renderer/i18n'
import type { ExplorerEntry } from '@renderer/lib/explorerEntry'
import { sourceLabel } from '@renderer/lib/sendItems'
import { EntryThumb } from '@renderer/components/thumbnail/EntryThumb'
import { EntryFacts } from './EntryFacts'

/** 속성 창(Alt+Enter, 메뉴). 원격·로컬 두 창을 하나로 합쳤다. Esc·바깥 클릭으로 닫는다. */
export function PropertiesDialog({
  entry,
  onClose
}: {
  entry: ExplorerEntry
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const closeRef = useRef<HTMLButtonElement>(null)
  useEscapeKey(onClose)
  useEffect(() => closeRef.current?.focus(), [])

  return (
    <div
      className="fade fixed inset-0 z-[70] flex items-center justify-center bg-black/35 p-6"
      onClick={onClose}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('properties.title')}
        className="pop flex max-h-full w-[460px] flex-col overflow-hidden rounded-2xl border border-[var(--bd)] bg-[var(--sf)] text-[var(--tx)] shadow-[var(--shadow)]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-4 border-b border-[var(--bd)] p-5">
          <div className="h-16 w-20 shrink-0 overflow-hidden rounded-[10px] bg-[var(--tile)]">
            <EntryThumb entry={entry} glyph="h-7 w-7" showSlow={false} request />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[17px] font-bold" title={entry.name}>
              {entry.name}
            </h2>
            <p className="mt-0.5 text-[12px] text-[var(--mu)]">{sourceLabel(entry)}</p>
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label={t('common.close')}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="scroll overflow-auto px-5 py-3">
          <EntryFacts entry={entry} />
        </div>
        <div className="flex justify-end border-t border-[var(--bd)] bg-[var(--bg)] px-5 py-3">
          <button
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-[10px] border border-[var(--bd)] bg-[var(--sf)] px-4 text-[13px] font-semibold hover:bg-[var(--hv)]"
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
