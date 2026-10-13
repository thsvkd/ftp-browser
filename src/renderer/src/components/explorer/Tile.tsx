import { Check, PackageCheck } from 'lucide-react'
import { useT } from '@renderer/i18n'
import { LABEL_H, SPRING_MS } from '@renderer/lib/explorerLayout'
import { cn, formatBytes } from '@renderer/lib/utils'
import { EntryThumb } from '@renderer/components/thumbnail/EntryThumb'
import { TransferRing } from '@renderer/components/thumbnail/TransferRing'
import { typeLabel } from './entryText'
import { InlineRename } from './InlineRename'
import { useItem, type ItemProps } from './useItem'

/** 그리드 타일: 4:3 썸네일(채우기), 이름, 부가 정보. 선택 체크·선반 표시·전송 고리·놓기 강조. */
export function Tile(
  p: ItemProps & { x: number; y: number; width: number; imageHeight: number }
): React.JSX.Element {
  const { entry } = p
  const t = useT()
  const { drop, dropOver, attrs } = useItem(p)
  return (
    <div
      {...attrs}
      data-tile
      title={entry.name}
      className={cn(
        'group absolute flex cursor-default select-none flex-col rounded-[12px] p-1 transition-colors',
        p.selected ? 'bg-[var(--acw)]' : 'hover:bg-[var(--hv)]'
      )}
      style={{ left: p.x, top: p.y, width: p.width, height: p.imageHeight + LABEL_H }}
    >
      <div
        className={cn(
          'relative overflow-hidden rounded-[10px] bg-[var(--tile)]',
          p.selected && 'ring-2 ring-[var(--ac)]',
          dropOver && (drop.valid ? 'ring-[3px] ring-[var(--ac)]' : 'ring-2 ring-[var(--dg)]')
        )}
        style={{ height: p.imageHeight - 8 }}
      >
        <EntryThumb
          entry={entry}
          folderPreview
          size={Math.round(p.width)}
          glyph={p.width < 130 ? 'h-7 w-7' : 'h-10 w-10'}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          data-nomarquee
          onClick={(e) => {
            e.stopPropagation()
            p.onToggle(entry)
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          className={cn(
            'absolute left-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 transition-opacity',
            p.selected
              ? 'border-[var(--ac)] bg-[var(--ac)] text-[var(--acx)] opacity-100'
              : 'border-white/90 bg-black/25 text-transparent opacity-0 hover:bg-black/40 group-hover:opacity-100'
          )}
        >
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        </button>
        {p.shelved && (
          <span
            className="absolute right-1.5 top-1.5 flex h-6 items-center rounded-full bg-[var(--sh)] px-1.5 text-[var(--shink)] shadow-sm"
            title={t('menu.removeFromShelf')}
          >
            <PackageCheck className="h-3.5 w-3.5" aria-hidden />
          </span>
        )}
        <span className="absolute bottom-1.5 right-1.5">
          <TransferRing entry={entry} />
        </span>
        {dropOver && (
          <span className="absolute inset-x-1.5 bottom-1.5 truncate rounded-md bg-black/60 px-2 py-1 text-center text-[11px] font-semibold text-white">
            {drop.valid ? drop.verb : drop.reason}
          </span>
        )}
        {dropOver && (
          <span
            className="spring-fill absolute inset-x-0 top-0 h-1 bg-[var(--ac)]"
            style={{ '--spring': `${SPRING_MS}ms` } as React.CSSProperties}
          />
        )}
      </div>
      <div className="min-w-0 px-1.5 pt-1.5">
        {p.renaming ? (
          <InlineRename initial={entry.name} onDone={(n) => p.onRename(entry, n)} />
        ) : (
          <div className="truncate text-[13px] font-semibold leading-5">{entry.name}</div>
        )}
        <div className="mono truncate text-[11px] leading-4 text-[var(--mu)]">
          {entry.type === 'file' ? formatBytes(entry.size) : typeLabel(entry)}
        </div>
      </div>
    </div>
  )
}
