import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
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
import { reducedMotion } from '@renderer/lib/flyTo'
import { dropShelf, locLabel, planVerb, sourceLabel } from '@renderer/lib/sendItems'
import { cn, formatBytes } from '@renderer/lib/utils'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useActiveTab } from '@renderer/stores/useTabsStore'
import { SourceBadge } from '@renderer/components/common/SourceBadge'
import {
  endDrag,
  startDrag,
  useDnd,
  useDropTarget,
  type DropState
} from '@renderer/components/explorer/dnd'
import { EntryThumb } from '@renderer/components/thumbnail/EntryThumb'

const fileBytes = (sum: number, e: ExplorerEntry): number => sum + (e.type === 'file' ? e.size : 0)

/**
 * 활성 탭으로 내려놓는 버튼. 방향은 항목과 탭의 쪽이 정한다(D15). 접힌 캡슐(`compact`)과 펼친
 * 패널이 같은 버튼을 쓴다(I1·I2) — 문구도 같아서 어느 쪽에서 눌러도 결과가 같다.
 */
export function ShelfSendButton({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const t = useT()
  const items = useShelfStore((s) => s.items)
  const tab = useActiveTab()
  const connected = useConnectedKeys()
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
  return (
    <button
      onClick={() => dest && void dropShelf(dest)}
      disabled={!!invalid}
      title={invalid ? t(invalid) : dest?.path}
      className={cn(
        'group flex min-w-0 items-center bg-[var(--sh)] text-left text-[var(--shink)] transition hover:brightness-105 active:scale-[.99] disabled:cursor-not-allowed disabled:bg-[var(--bd)] disabled:text-[var(--mu)]',
        compact
          ? 'h-10 max-w-[300px] gap-2.5 rounded-full pl-3.5 pr-4'
          : 'min-h-[48px] max-w-[62%] shrink-0 gap-3 rounded-[12px] px-3.5 py-1.5 shadow-sm disabled:shadow-none shelf-narrow-full'
      )}
    >
      <Icon
        className={compact ? 'h-4 w-4 shrink-0' : 'h-5 w-5 shrink-0'}
        strokeWidth={2.25}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate font-bold',
            compact ? 'text-[13px] leading-4' : 'text-[14px] leading-5'
          )}
        >
          {invalid || !plan || !dest
            ? t('shelf.cantDropHere')
            : t('send.toLocation', { verb: planVerb(plan), location: locLabel(dest) })}
        </span>
        <span
          className={cn(
            'block truncate font-medium opacity-75',
            compact ? 'text-[10.5px] leading-[14px]' : 'text-[11.5px] leading-4'
          )}
        >
          {invalid
            ? t(invalid)
            : plan?.here
              ? t('send.alreadyHere', { count: plan.here })
              : dest && `→ ${sourceLabel(dest)} › ${dest.path}`}
        </span>
      </span>
      {!invalid && !compact && (
        <kbd
          aria-hidden
          className="mono shrink-0 rounded-md bg-black/10 px-1.5 py-0.5 text-[10.5px] font-semibold"
        >
          Enter
        </kbd>
      )}
    </button>
  )
}

/** 휠(가운데) 클릭으로 뺀다(I6). mousedown을 막아 Windows의 자동 스크롤 커서가 뜨지 않게 한다. */
function ItemTile({
  entry,
  dest
}: {
  entry: ExplorerEntry
  dest: Loc | undefined
}): React.JSX.Element {
  const t = useT()
  const remove = (): void => useShelfStore.getState().remove([locKey(entry)])
  const size = entry.type === 'directory' ? t('send.folderContents') : formatBytes(entry.size)
  const arrow = !dest || entry.side === dest.side ? '' : entry.side === 'remote' ? ' ↓' : ' ↑'
  return (
    <li
      tabIndex={0}
      // 선반 항목도 기존 startDrag로 끈다(F6). data-path는 고스트의 썸네일 조회에 쓰인다(함정 C).
      data-path={entry.path}
      draggable
      onDragStart={(e) => startDrag(e, [entry], true)}
      onDragEnd={endDrag}
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        e.preventDefault()
        remove()
      }}
      aria-label={t('shelf.itemLabel', { name: entry.name, source: sourceLabel(entry), size })}
      onKeyDown={(e) => {
        const li = e.currentTarget
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault()
          const next = (li.nextElementSibling ?? li.previousElementSibling) as HTMLElement | null
          remove()
          next?.focus()
        } else if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(e.key)) {
          e.preventDefault()
          const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight'
          const sib = forward ? li.nextElementSibling : li.previousElementSibling
          ;(sib as HTMLElement | null)?.focus()
        }
      }}
      className="group relative w-[112px] shrink-0 cursor-grab rounded-xl p-1 hover:bg-[var(--hv)] focus-visible:outline-offset-[-2px]"
    >
      {/* data-card는 syncFilm이 보이는 앞 3장에만 단다(I9) */}
      <span className="relative block h-[78px] w-[104px] overflow-hidden rounded-[10px] bg-[var(--tile)]">
        <EntryThumb entry={entry} glyph="h-7 w-7" request showSlow={false} ext={false} />
      </span>
      <span
        className="mt-1.5 block h-[15px] truncate text-[11.5px] font-semibold leading-[15px]"
        title={entry.path}
      >
        {entry.name}
      </span>
      <span className="mono flex h-[14px] items-center gap-1 text-[10.5px] leading-[14px] text-[var(--mu)]">
        <span
          data-side={entry.side}
          aria-hidden
          className={cn(
            'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
            entry.side === 'remote' ? 'bg-[var(--ac)]' : 'bg-[var(--local)]'
          )}
        />
        <span className="truncate">
          {size}
          {arrow}
        </span>
      </span>
      <button
        tabIndex={-1}
        onClick={remove}
        aria-label={t('shelf.remove', { name: entry.name })}
        className="absolute right-0 top-0 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--bd)] bg-[var(--sf)] text-[var(--mu)] opacity-0 shadow-sm hover:text-[var(--tx)] group-hover:opacity-100 group-focus:opacity-100"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </li>
  )
}

/**
 * 필름의 가장자리 표시(`data-l`·`data-r`)와 내려놓기 더미(I9)를 맞춘다. 더미는 지금 **보이는** 앞
 * 3장이다 — 끝으로 스크롤돼 있으면 처음 3장은 필름 밖이라 엉뚱한 곳에서 날아간다.
 */
function syncFilm(el: HTMLElement): void {
  el.dataset.l = String(el.scrollLeft > 2)
  el.dataset.r = String(el.scrollLeft + el.clientWidth < el.scrollWidth - 2)
  const box = el.getBoundingClientRect()
  let cards = 0
  for (const li of Array.from(el.children)) {
    const thumb = li.firstElementChild
    if (!thumb) continue
    const r = li.getBoundingClientRect()
    const visible = cards < 3 && r.right > box.left + 8 && r.left < box.right - 8
    if (visible) cards++
    thumb.toggleAttribute('data-card', visible)
  }
}

/**
 * 가로 필름(I7): 세로 휠을 가로 스크롤로, 넘친 쪽 가장자리 표시(`data-l`·`data-r`), 새로 담기면
 * 끝까지 따라간다. jsdom에는 ResizeObserver·scrollTo가 없어 있으면만 쓴다(함정 B).
 */
function useFilm(ref: RefObject<HTMLUListElement | null>, count: number): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const edges = (): void => syncFilm(el)
    // 트랙패드의 가로 제스처(가로 성분이 큼)는 그대로 둔다
    const wheel = (e: WheelEvent): void => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(edges) : null
    ro?.observe(el)
    el.addEventListener('scroll', edges, { passive: true })
    el.addEventListener('wheel', wheel, { passive: false })
    edges()
    return () => {
      ro?.disconnect()
      el.removeEventListener('scroll', edges)
      el.removeEventListener('wheel', wheel)
    }
  }, [ref])

  const seen = useRef(count)
  useLayoutEffect(() => {
    const el = ref.current
    const added = count > seen.current
    seen.current = count
    if (!el) return
    // 빼서 넘침이 사라져도 ResizeObserver는 울리지 않는다(ul 크기는 그대로) — 개수가 바뀔 때마다 맞춘다
    syncFilm(el)
    if (!added) return
    const smooth = !reducedMotion()
    if (typeof el.scrollTo === 'function')
      el.scrollTo({ left: el.scrollWidth, behavior: smooth ? 'smooth' : 'auto' })
    const last = el.lastElementChild
    if (smooth && last && typeof last.animate === 'function')
      last.animate(
        [
          { opacity: 0, transform: 'translateY(8px) scale(0.9)' },
          { opacity: 1, transform: 'none' }
        ],
        { duration: 260, easing: 'cubic-bezier(0.2, 0.85, 0.25, 1)' }
      )
  }, [count, ref])
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
 * 펼친 섬의 패널(I2): 머리(개수·용량·출처·비우기·접기) · 가로 필름 · 바닥(안내 + 내려놓기).
 * 선반 안에서 Enter, 창 어디서나 Ctrl+Enter(AppShell)로도 내려놓는다.
 */
export function Shelf(): React.JSX.Element {
  const t = useT()
  const items = useShelfStore((s) => s.items)
  const tab = useActiveTab()
  const drop = useDropTarget('shelf', 'shelf')
  const film = useRef<HTMLUListElement>(null)
  useFilm(film, items.length)
  if (!items.length) return <EmptyShelf drop={drop} />

  const entries = items.map((i) => i.entry)
  const dest = tab?.loc
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
      className="flex flex-col"
    >
      <div className="flex items-center gap-2.5 pb-2.5 pl-[18px] pr-3 pt-3.5">
        <span className="text-[15px] font-extrabold">{t('shelf.title')}</span>
        <span className="mono flex shrink-0 gap-1.5 text-[12px] font-semibold text-[var(--mu)]">
          <span>{t('common.itemCount', { count: items.length })}</span>
          <span aria-hidden>·</span>
          <span>{formatBytes(entries.reduce(fileBytes, 0))}</span>
        </span>
        <span className="shelf-narrow-hide flex min-w-0 gap-1">
          {sides.map(({ side, list }) => (
            <span
              key={side}
              className="flex h-[22px] min-w-0 items-center gap-1 rounded-full border border-[var(--bd)] bg-[var(--sf)] pl-0.5 pr-2 text-[11px] font-semibold"
            >
              <SourceBadge side={side} size={16} />
              <span className="truncate">{sourceLabel(list[0])}</span>
              <span className="mono">{list.length}</span>
            </span>
          ))}
        </span>
        <span className="flex-1" />
        <button
          onClick={() => useShelfStore.getState().clear()}
          aria-label={t('shelf.clear')}
          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11.5px] font-semibold text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          <span className="shelf-narrow-hide">{t('shelf.clear')}</span>
        </button>
        <button
          onClick={() => useShelfStore.getState().setDockOpen(false)}
          aria-label={t('shelf.collapse')}
          aria-expanded
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]"
        >
          <ChevronDown className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <ul
        ref={film}
        data-shelf-film
        // 펼침에서는 필름의 보이는 앞 3장이 내려놓기 더미다(I9)
        data-shelf-stack
        aria-label={t('shelf.items')}
        className="shelf-film flex gap-2.5 px-[18px] pb-1.5 pt-1"
      >
        {entries.map((entry) => (
          <ItemTile key={locKey(entry)} entry={entry} dest={dest} />
        ))}
      </ul>
      <div className="shelf-narrow-wrap flex items-center gap-3 border-t border-[var(--bd)] py-3 pl-[18px] pr-3">
        <p className="min-w-0 flex-1 text-[12px] leading-4 text-[var(--mu)]">
          {t('shelf.panelHint')}
        </p>
        <ShelfSendButton />
      </div>
    </div>
  )
}
