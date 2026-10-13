import {
  ArrowDownToLine,
  ArrowUpFromLine,
  MoveRight,
  Package,
  PackageOpen,
  Trash2,
  X
} from 'lucide-react'
import { useT } from '@renderer/i18n'
import { locKey, type ExplorerEntry, type Loc } from '@renderer/lib/explorerEntry'
import { planSend } from '@renderer/lib/sendPlan'
import { useConnectedKeys } from '@renderer/lib/connections'
import { dropShelf, locLabel, planVerb, sourceLabel } from '@renderer/lib/sendItems'
import { cn, formatBytes } from '@renderer/lib/utils'
import { useShelfStore, type ShelfItem } from '@renderer/stores/useShelfStore'
import { useActiveTab } from '@renderer/stores/useTabsStore'
import { SourceBadge } from '@renderer/components/common/SourceBadge'
import { useDnd, useDropTarget, type DropState } from '@renderer/components/explorer/dnd'
import { EntryThumb } from '@renderer/components/thumbnail/EntryThumb'

const fileBytes = (sum: number, e: ExplorerEntry): number => sum + (e.type === 'file' ? e.size : 0)

/** 위의 세 장을 부채처럼 겹친 더미와 개수. 내려놓으면 이 카드들이 활동 알약으로 날아간다. */
function Stack({ items }: { items: ShelfItem[] }): React.JSX.Element {
  const top = items.slice(-3)
  return (
    <div data-shelf-stack aria-hidden className="relative h-[96px] w-[128px] shrink-0">
      {top.map((it, i) => (
        <div
          key={locKey(it.entry)}
          data-card
          className="absolute left-2 top-1.5 h-[84px] w-[112px] overflow-hidden rounded-[10px] border-2 border-[var(--sf)] bg-[var(--tile)] shadow-md"
          style={{
            transform: `rotate(${[-8, 6, 0].slice(3 - top.length)[i]}deg) translateY(${(top.length - 1 - i) * -2}px)`
          }}
        >
          <EntryThumb entry={it.entry} glyph="h-8 w-8" request showSlow={false} ext={false} />
        </div>
      ))}
      <span className="mono absolute -right-1 -top-1 flex h-7 min-w-7 items-center justify-center rounded-full bg-[var(--sh)] px-1.5 text-[13px] font-bold text-[var(--shink)] shadow">
        {items.length}
      </span>
    </div>
  )
}

function ItemRow({
  entry,
  dest
}: {
  entry: ExplorerEntry
  dest: Loc | undefined
}): React.JSX.Element {
  const t = useT()
  const remove = (): void => useShelfStore.getState().remove([locKey(entry)])
  const size = entry.type === 'directory' ? t('send.folderContents') : formatBytes(entry.size)
  const arrow = !dest || entry.side === dest.side ? '' : entry.side === 'remote' ? ' · ↓' : ' · ↑'
  return (
    <li
      tabIndex={0}
      aria-label={t('shelf.itemLabel', { name: entry.name, source: sourceLabel(entry), size })}
      onKeyDown={(e) => {
        const li = e.currentTarget
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault()
          const next = (li.nextElementSibling ?? li.previousElementSibling) as HTMLElement | null
          remove()
          next?.focus()
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const sib = e.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling
          ;(sib as HTMLElement | null)?.focus()
        }
      }}
      className="group flex h-11 items-center gap-2.5 rounded-[10px] px-1.5 hover:bg-[var(--hv)] focus-visible:outline-offset-[-2px]"
    >
      <span className="relative h-8 w-8 shrink-0 overflow-hidden rounded-md bg-[var(--tile)]">
        <EntryThumb entry={entry} glyph="h-4 w-4" request showSlow={false} ext={false} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium leading-4" title={entry.path}>
          {entry.name}
        </span>
        <span className="mono flex items-center gap-1 text-[10.5px] leading-4 text-[var(--mu)]">
          <span
            data-side={entry.side}
            aria-hidden
            className={cn(
              'inline-block h-1.5 w-1.5 rounded-full',
              entry.side === 'remote' ? 'bg-[var(--ac)]' : 'bg-[var(--local)]'
            )}
          />
          {size}
          {arrow}
        </span>
      </span>
      <button
        tabIndex={-1}
        onClick={remove}
        aria-label={t('shelf.remove', { name: entry.name })}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--mu)] opacity-0 hover:bg-[var(--hv)] hover:text-[var(--tx)] group-hover:opacity-100 group-focus:opacity-100"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </li>
  )
}

/** 비어 있는 선반: 끌어다 놓는 자리와 담는 방법. 놓기 대상은 `Shelf`가 등록한 것을 받는다. */
function EmptyShelf({ drop }: { drop: DropState }): React.JSX.Element {
  const t = useT()
  const dragging = useDnd((s) => s.items !== null)
  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <div
        data-shelf-target
        {...drop.handlers}
        className={cn(
          'flex flex-1 flex-col items-center justify-center rounded-[14px] border-2 border-dashed px-5 py-8 text-center transition-colors',
          drop.over
            ? 'border-[var(--sh)] bg-[var(--shw)]'
            : dragging
              ? 'border-[var(--sh)]'
              : 'border-[var(--bd2)]'
        )}
      >
        <span
          className={cn(
            'mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--shw)] text-[var(--shx)] transition-transform',
            drop.over && 'scale-110'
          )}
        >
          {drop.over ? (
            <PackageOpen className="h-7 w-7" aria-hidden />
          ) : (
            <Package className="h-7 w-7" strokeWidth={1.75} aria-hidden />
          )}
        </span>
        <p className="text-[14px] font-bold">
          {drop.over ? t('shelf.dropHere') : t('menu.shelfEmpty')}
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--mu)]">{t('shelf.empty')}</p>
      </div>
    </div>
  )
}

/**
 * 선반(레일 몸통). 담은 항목과, 활성 탭으로 내려놓는 버튼. 방향은 항목과 탭의 쪽이 정한다(D15).
 * 선반 안에서 Enter, 창 어디서나 Ctrl+Enter(AppShell)로도 내려놓는다.
 */
export function Shelf(): React.JSX.Element {
  const t = useT()
  const items = useShelfStore((s) => s.items)
  const tab = useActiveTab()
  const connected = useConnectedKeys()
  const drop = useDropTarget('shelf', 'shelf')
  if (!items.length) return <EmptyShelf drop={drop} />

  const entries = items.map((i) => i.entry)
  const dest = tab?.loc
  const plan = dest ? planSend(entries, dest, connected) : null
  const invalid = plan ? plan.invalid : 'send.invalidNothing'
  const Icon =
    plan?.direction === 'upload'
      ? ArrowUpFromLine
      : plan?.direction === 'download'
        ? ArrowDownToLine
        : MoveRight
  const sides = (['remote', 'local'] as const)
    .map((side) => ({ side, list: entries.filter((e) => e.side === side) }))
    .filter((g) => g.list.length)

  return (
    <div
      data-shelf-target
      {...drop.handlers}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || (e.target as HTMLElement).tagName === 'BUTTON' || !dest) return
        e.preventDefault()
        void dropShelf(dest)
      }}
      className={cn('flex min-h-0 flex-1 flex-col', drop.over && 'bg-[var(--shw)]')}
    >
      <div className="flex items-center gap-3 px-4 pb-3 pt-4">
        <Stack items={items} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold leading-5">
            {t('common.itemCount', { count: items.length })}
          </div>
          <div className="mono text-[12px] font-semibold text-[var(--mu)]">
            {formatBytes(entries.reduce(fileBytes, 0))}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {sides.map(({ side, list }) => (
              <span
                key={side}
                className="flex h-6 max-w-full items-center gap-1 rounded-full bg-[var(--sf)] pl-0.5 pr-2 text-[11.5px] font-semibold"
              >
                <SourceBadge side={side} size={20} />
                <span className="truncate">{sourceLabel(list[0])}</span>
                <span className="mono">{list.length}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
      <ul aria-label={t('shelf.items')} className="scroll min-h-0 flex-1 overflow-y-auto px-2.5">
        {entries.map((entry) => (
          <ItemRow key={locKey(entry)} entry={entry} dest={dest} />
        ))}
      </ul>
      <div className="space-y-2.5 border-t border-[var(--bd)] bg-[var(--sb)] p-3">
        <button
          onClick={() => dest && void dropShelf(dest)}
          disabled={!!invalid}
          title={invalid ? t(invalid) : dest?.path}
          className="group flex min-h-[52px] w-full items-center gap-3 rounded-[12px] bg-[var(--sh)] px-3.5 py-2 text-left text-[var(--shink)] shadow-sm transition hover:brightness-105 active:scale-[.99] disabled:cursor-not-allowed disabled:bg-[var(--bd)] disabled:text-[var(--mu)] disabled:shadow-none"
        >
          <Icon className="h-5 w-5 shrink-0" strokeWidth={2.25} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-bold leading-5">
              {invalid || !plan || !dest
                ? t('shelf.cantDropHere')
                : t('send.toLocation', { verb: planVerb(plan), location: locLabel(dest) })}
            </span>
            <span className="block truncate text-[11.5px] font-medium leading-4 opacity-75">
              {invalid
                ? t(invalid)
                : plan?.here
                  ? t('send.alreadyHere', { count: plan.here })
                  : dest && `→ ${sourceLabel(dest)} › ${dest.path}`}
            </span>
          </span>
          {!invalid && (
            <kbd
              aria-hidden
              className="mono shrink-0 rounded-md bg-black/10 px-1.5 py-0.5 text-[10.5px] font-semibold"
            >
              Enter
            </kbd>
          )}
        </button>
        <div className="flex justify-end">
          <button
            onClick={() => useShelfStore.getState().clear()}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-semibold text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> {t('shelf.clear')}
          </button>
        </div>
      </div>
    </div>
  )
}
