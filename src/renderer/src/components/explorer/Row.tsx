import { PackageCheck } from 'lucide-react'
import { useT } from '@renderer/i18n'
import { LIST_COLS, ROW } from '@renderer/lib/explorerLayout'
import { cn, formatBytes, formatDate } from '@renderer/lib/utils'
import { EntryThumb } from '@renderer/components/thumbnail/EntryThumb'
import { TransferRing } from '@renderer/components/thumbnail/TransferRing'
import { shortDate, typeLabel } from './entryText'
import { InlineRename } from './InlineRename'
import { useItem, type ItemProps } from './useItem'

/** 리스트 행: 이름(작은 썸네일), 크기(오른쪽 정렬), 수정한 날짜, 종류. */
export function Row(p: ItemProps & { top: number }): React.JSX.Element {
  const { entry } = p
  const t = useT()
  const { drop, dropOver, attrs } = useItem(p)
  return (
    <div
      {...attrs}
      className={cn(
        'absolute inset-x-2 grid cursor-default select-none items-center gap-3 rounded-lg px-2.5',
        LIST_COLS,
        p.selected
          ? p.listFocused
            ? 'bg-[var(--acw)]'
            : 'bg-[var(--selin)]'
          : 'hover:bg-[var(--hv)]',
        p.cursor && p.listFocused && 'outline outline-2 -outline-offset-2 outline-[var(--ac)]',
        dropOver &&
          (drop.valid ? 'bg-[var(--acw)] ring-2 ring-[var(--ac)]' : 'ring-2 ring-[var(--dg)]')
      )}
      style={{ top: p.top + 2, height: ROW - 4 }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="relative h-6 w-6 shrink-0 overflow-hidden rounded-[5px] bg-[var(--tile)]">
          <EntryThumb entry={entry} glyph="h-4 w-4" showSlow={false} ext={false} />
        </span>
        {p.renaming ? (
          <InlineRename initial={entry.name} onDone={(n) => p.onRename(entry, n)} />
        ) : (
          <span className="truncate text-[13px]" title={entry.name}>
            {entry.name}
          </span>
        )}
        {p.shelved && (
          <PackageCheck
            className="h-3.5 w-3.5 shrink-0 text-[var(--shx)]"
            aria-label={t('menu.removeFromShelf')}
          />
        )}
        <span className="relative ml-auto shrink-0 scale-[0.8]">
          <TransferRing entry={entry} size={24} />
        </span>
        {dropOver && (
          <span
            className={cn(
              'shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold',
              drop.valid ? 'bg-[var(--ac)] text-[var(--acx)]' : 'bg-[var(--dg)] text-white'
            )}
          >
            {drop.valid ? drop.verb : drop.reason}
          </span>
        )}
      </div>
      <span className="mono text-right text-[12px] text-[var(--mu)]">
        {entry.type === 'file' ? formatBytes(entry.size) : '—'}
      </span>
      <span
        className="tnum truncate text-[12px] text-[var(--mu)]"
        title={formatDate(entry.modifiedAt)}
      >
        {shortDate(entry.modifiedAt)}
      </span>
      <span className="truncate text-[12px] text-[var(--mu)]">{typeLabel(entry)}</span>
    </div>
  )
}
