import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes } from 'react'
import {
  ArrowDownAZ,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  ImageIcon,
  Info,
  LayoutGrid,
  List,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { useT, type MessageKey } from '@renderer/i18n'
import type { SortKey } from '@renderer/lib/entryList'
import { locKey, parentPath, type Loc } from '@renderer/lib/explorerEntry'
import { fitCrumbs, pathCrumbs, type Crumb } from '@renderer/lib/pathCrumbs'
import { SPRING_MS } from '@renderer/lib/explorerLayout'
import { sourceLabel } from '@renderer/lib/sendItems'
import { cn } from '@renderer/lib/utils'
import { useListingStore } from '@renderer/stores/useListingStore'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useTabsStore, type Tab } from '@renderer/stores/useTabsStore'
import { SourceBadge } from '@renderer/components/common/SourceBadge'
import { useDropTarget } from './dnd'
import { ItemMenu, type MenuItem } from './ItemMenu'

const SORT_LABEL: Record<SortKey, MessageKey> = {
  name: 'file.name',
  modified: 'file.modified',
  size: 'file.size',
  type: 'file.type'
}

const iconBtn =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)] disabled:opacity-35 disabled:hover:bg-transparent'

/** 경로 입력(Ctrl+L, 빈 곳 클릭). 그 폴더를 읽어 보고 되면 이동, 안 되면 토스트. */
function PathInput({ tab, onDone }: { tab: Tab; onDone: () => void }): React.JSX.Element {
  const t = useT()
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const go = async (raw: string): Promise<void> => {
    const typed = raw.trim()
    if (!typed) return onDone()
    // 드라이브 문자를 쓰면 내 PC, 아니면 탭의 쪽이다(로컬 macOS·Linux 경로도 '/'로 시작한다).
    const side = /^[a-z]:/i.test(typed) ? 'local' : tab.loc.side
    let path = typed
    if (side === 'local' && /^[a-z]:[\\/]?$/i.test(path)) path = `${path.slice(0, 2)}\\`
    else if (path.length > 1) path = path.replace(/[\\/]+$/, '')
    const loc: Loc = { side, path, ...(side === 'remote' ? { server: tab.loc.server } : {}) }
    await useListingStore.getState().load(loc)
    const listing = useListingStore.getState().byKey[locKey(loc)]
    if (listing?.status !== 'ready') {
      toast.error(t('toast.navigateFailed', { path: typed }), { description: listing?.error })
      return
    }
    useTabsStore.getState().navigate(loc)
    onDone()
  }
  return (
    <input
      ref={ref}
      defaultValue={tab.loc.path}
      aria-label={t('path.edit')}
      spellCheck={false}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') void go(e.currentTarget.value)
        if (e.key === 'Escape') onDone()
      }}
      onBlur={onDone}
      className="mono h-7 min-w-0 flex-1 rounded-md bg-[var(--sf)] px-2 text-[12.5px] text-[var(--tx)] outline outline-2 outline-[var(--ac)]"
    />
  )
}

/**
 * 놓기 대상인 경로 조각(Test-827): 놓으면 그 폴더로 보내고, 머무르면 연다. 지금 폴더의 조각은 받지 않는다.
 * 끄는 동안 무엇을 할지(동사)를 조각 안에 보인다.
 */
function DropCrumb({
  loc,
  current,
  className,
  title,
  children,
  ...rest
}: { loc: Loc; current?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  const drop = useDropTarget(`crumb:${locKey(loc)}`, current ? null : loc, {
    spring: () => useTabsStore.getState().navigate(loc),
    springMs: SPRING_MS
  })
  return (
    <button
      {...rest}
      onDragOver={drop.handlers.onDragOver}
      onDrop={drop.handlers.onDrop}
      title={drop.over ? (drop.valid ? drop.verb : (drop.reason ?? '')) : title}
      className={cn(
        className,
        drop.over &&
          (drop.valid
            ? 'bg-[var(--acw)] text-[var(--ac)] ring-2 ring-[var(--ac)]'
            : 'ring-2 ring-[var(--dg)]')
      )}
    >
      {children}
      {drop.over && drop.valid && (
        <span className="ml-1 rounded-full bg-[var(--ac)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--acx)]">
          {drop.verb}
        </span>
      )}
    </button>
  )
}

/** 접힌 조각: 루트 배지 + "…" + 들어가는 만큼의 뒤쪽 조각. 폭을 재어 `fitCrumbs`로 고른다. */
function Crumbs({
  loc,
  onEdit,
  onMenu
}: {
  loc: Loc
  onEdit: () => void
  onMenu: (x: number, y: number, hidden: Crumb[]) => void
}): React.JSX.Element {
  const t = useT()
  const crumbs = pathCrumbs(loc.side, loc.path)
  const navRef = useRef<HTMLElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<{ path: string; keep: number } | null>(null)

  useLayoutEffect(() => {
    const nav = navRef.current
    const measure = measureRef.current
    if (!nav || !measure) return
    const update = (): void => {
      const widths = [...measure.children].map((c) => (c as HTMLElement).offsetWidth)
      const more = widths.pop() ?? 0
      const r = fitCrumbs(crumbs, widths, nav.clientWidth - 24, more)
      setFit({ path: loc.path, keep: r.shown.length })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(nav)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 경로가 바뀔 때만 다시 잰다
  }, [loc.side, loc.path])

  const below = crumbs.slice(1)
  const keep = fit?.path === loc.path ? fit.keep : below.length
  const hidden = below.slice(0, below.length - keep)
  const shown = below.slice(below.length - keep)
  const nav = (path: string): void => useTabsStore.getState().navigate({ ...loc, path })
  const crumbCls =
    'h-7 min-w-0 max-w-[260px] truncate rounded-md px-1.5 text-[13px] text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]'

  return (
    <>
      <nav
        ref={navRef}
        aria-label={t('path.label')}
        title={t('path.editHint')}
        className="flex min-w-0 flex-1 items-center overflow-hidden"
        onClick={(e) => e.target === e.currentTarget && onEdit()}
      >
        <DropCrumb
          loc={{ ...loc, path: crumbs[0].path }}
          current={crumbs.length === 1}
          onClick={() => nav(crumbs[0].path)}
          aria-label={t('place.root', { source: sourceLabel(loc) })}
          title={`${sourceLabel(loc)} · ${crumbs[0].path}`}
          className="flex h-7 shrink-0 items-center rounded-md pr-1 hover:bg-[var(--hv)]"
        >
          <SourceBadge side={loc.side} size={22} />
        </DropCrumb>
        {hidden.length > 0 && (
          <span className="flex shrink-0 items-center">
            <ChevronRight className="h-3.5 w-3.5 text-[var(--mu)]" aria-hidden />
            <button
              aria-label={t('path.hidden')}
              aria-haspopup="menu"
              className="h-7 rounded-md px-1.5 text-[var(--mu)] hover:bg-[var(--hv)]"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                onMenu(r.left, r.bottom + 4, hidden)
              }}
            >
              …
            </button>
          </span>
        )}
        {shown.map((c, i) => {
          const current = i === shown.length - 1
          return (
            <span
              key={c.path}
              className={cn('flex items-center', current && keep === 1 ? 'min-w-0' : 'shrink-0')}
            >
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--mu)]" aria-hidden />
              <DropCrumb
                loc={{ ...loc, path: c.path }}
                current={current}
                onClick={() => !current && nav(c.path)}
                aria-current={current ? 'location' : undefined}
                title={c.path}
                className={cn(crumbCls, current && 'font-semibold text-[var(--tx)]')}
              >
                {c.name}
              </DropCrumb>
            </span>
          )
        })}
        <span className="h-full min-w-6 flex-1 cursor-text" onClick={onEdit} aria-hidden />
      </nav>
      {/* 조각 폭을 재는 보이지 않는 줄. 마지막 자식은 "…" 버튼이다. */}
      <div
        ref={measureRef}
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 flex whitespace-nowrap"
      >
        <span className="flex w-[30px] shrink-0" />
        {below.map((c) => (
          <span key={c.path} className="flex shrink-0 items-center">
            <span className="w-3.5" />
            <span className="max-w-[260px] truncate px-1.5 text-[13px]">{c.name}</span>
          </span>
        ))}
        <span className="w-[42px] shrink-0" />
      </div>
    </>
  )
}

export interface PathBarProps {
  tab: Tab
  editing: boolean
  onEditingChange: (editing: boolean) => void
  /** 사진만 칩으로 빠진 수 */
  photosHidden: number
  canWrite: boolean
  onNewFolder: () => void
  onReload: () => void
}

/** 경로 막대: ‹ › ↑, 접히는 조각(빈 곳·Ctrl+L로 입력), 찾기, 사진만, 정렬, 보기, 새 폴더, 세부 정보. */
export function PathBar({
  tab,
  editing,
  onEditingChange,
  photosHidden,
  canWrite,
  onNewFolder,
  onReload
}: PathBarProps): React.JSX.Element {
  const t = useT()
  const railTab = useShelfStore((s) => s.railTab)
  const barRef = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    items: MenuItem[]
    label: string
  } | null>(null)
  const patch = (p: Partial<Tab>): void => useTabsStore.getState().patchTab(tab.id, p)
  const { loc, sort } = tab

  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const update = (): void => setCompact(bar.clientWidth > 0 && bar.clientWidth < 900)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [])

  const sortItems: MenuItem[] = [
    ...(['name', 'modified', 'size', 'type'] as const).map((key) => ({
      label: t(SORT_LABEL[key]),
      icon: sort.key === key ? Check : undefined,
      onSelect: () => patch({ sort: { ...sort, key } })
    })),
    'sep',
    {
      label: t(sort.dir === 'asc' ? 'sort.descending' : 'sort.ascending'),
      icon: ArrowDownAZ,
      onSelect: () => patch({ sort: { ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' } })
    },
    {
      label: t('sort.foldersFirst'),
      icon: sort.foldersFirst ? Check : undefined,
      onSelect: () => patch({ sort: { ...sort, foldersFirst: !sort.foldersFirst } })
    }
  ]
  const sortTitle = t('sort.current', {
    key: t(SORT_LABEL[sort.key]),
    direction: t(sort.dir === 'asc' ? 'sort.ascending' : 'sort.descending')
  })
  const showSearch = !compact || searchOpen || !!tab.query

  return (
    <div
      ref={barRef}
      className="relative flex h-[52px] shrink-0 items-center gap-1.5 border-b border-[var(--bd)] px-3"
    >
      <button
        className={iconBtn}
        disabled={!tab.back.length}
        onClick={() => useTabsStore.getState().goBack()}
        title={t('path.backTooltip')}
        aria-label={t('explorer.back')}
      >
        <ChevronLeft className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
      </button>
      <button
        className={iconBtn}
        disabled={!tab.fwd.length}
        onClick={() => useTabsStore.getState().goForward()}
        title={t('path.forwardTooltip')}
        aria-label={t('explorer.forward')}
      >
        <ChevronRight className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
      </button>
      <button
        className={iconBtn}
        disabled={parentPath(loc.side, loc.path) === null}
        onClick={() => useTabsStore.getState().goUp()}
        title={t('path.upTooltip')}
        aria-label={t('path.up')}
      >
        <ArrowUp className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
      </button>

      <div className="relative ml-1 flex h-9 min-w-[200px] flex-1 items-center overflow-hidden rounded-[10px] border border-[var(--bd)] bg-[var(--bg)] pl-1.5 pr-1">
        {editing ? (
          <PathInput tab={tab} onDone={() => onEditingChange(false)} />
        ) : (
          <Crumbs
            loc={loc}
            onEdit={() => onEditingChange(true)}
            onMenu={(x, y, hidden) =>
              setMenu({
                x,
                y,
                label: t('path.hidden'),
                items: hidden.map((c) => ({
                  label: c.name,
                  icon: FolderOpen,
                  onSelect: () => useTabsStore.getState().navigate({ ...loc, path: c.path })
                }))
              })
            }
          />
        )}
        <button
          className={cn(iconBtn, 'h-7 w-7')}
          onClick={onReload}
          title={t('toolbar.refreshTooltip')}
          aria-label={t('toolbar.refresh')}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {showSearch ? (
        <label
          className={cn(
            'relative ml-1 flex h-9 shrink-0 items-center',
            compact ? 'w-[150px]' : 'w-[200px]'
          )}
        >
          <Search
            className="pointer-events-none absolute left-2.5 h-4 w-4 text-[var(--mu)]"
            aria-hidden
          />
          <input
            // 목록의 Ctrl+F가 이 id로 칸을 찾는다(좁을 때는 돋보기 버튼이 같은 id다).
            id={`explorer-filter-${tab.id}`}
            autoFocus={compact && searchOpen}
            onBlur={() => setSearchOpen(false)}
            value={tab.query}
            onChange={(e) => patch({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                patch({ query: '' })
                document.getElementById(`explorer-list-${tab.id}`)?.focus()
              } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                e.preventDefault()
                document.getElementById(`explorer-list-${tab.id}`)?.focus()
              }
            }}
            placeholder={t('filter.find')}
            aria-label={t('filter.find')}
            title={t('filter.findTooltip')}
            className="h-full w-full rounded-[10px] border border-[var(--bd)] bg-[var(--bg)] pl-8 pr-7 text-[13px] text-[var(--tx)] outline-none placeholder:text-[var(--mu)] focus:border-[var(--ac)] focus:bg-[var(--sf)]"
          />
          {tab.query && (
            <button
              onClick={() => patch({ query: '' })}
              className="absolute right-1.5 flex h-6 w-6 items-center justify-center rounded-md text-[var(--mu)] hover:bg-[var(--hv)]"
              aria-label={t('filter.clear')}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </label>
      ) : (
        <button
          id={`explorer-filter-${tab.id}`}
          className={cn(iconBtn, 'h-9 w-9')}
          onClick={() => setSearchOpen(true)}
          title={t('filter.findTooltip')}
          aria-label={t('filter.find')}
        >
          <Search className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
        </button>
      )}

      <button
        aria-pressed={tab.photosOnly}
        onClick={() => patch({ photosOnly: !tab.photosOnly })}
        title={t('filter.photosOnly')}
        aria-label={t('filter.photosOnly')}
        className={cn(
          'flex h-9 shrink-0 items-center gap-1.5 rounded-full border text-[12.5px] font-semibold',
          compact ? 'px-2.5' : 'px-3',
          tab.photosOnly
            ? 'border-transparent bg-[var(--acw)] text-[var(--ac)]'
            : 'border-[var(--bd)] text-[var(--mu)] hover:bg-[var(--hv)]'
        )}
      >
        <ImageIcon className="h-4 w-4" aria-hidden />
        {!compact && <span aria-hidden>{t('category.image')}</span>}
        {tab.photosOnly && photosHidden > 0 && (
          <span aria-hidden className="mono rounded-full bg-[var(--sf)] px-1.5 text-[10.5px]">
            −{photosHidden}
          </span>
        )}
      </button>

      <button
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-semibold text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setMenu({ x: r.right - 232, y: r.bottom + 4, items: sortItems, label: t('sort.label') })
        }}
        aria-haspopup="menu"
        aria-label={t('sort.label')}
        title={sortTitle}
      >
        <ArrowUpDown className="h-4 w-4" aria-hidden />
        {!compact && <span aria-hidden>{t(SORT_LABEL[sort.key])}</span>}
        <span aria-hidden className="mono text-[11px]">
          {sort.dir === 'asc' ? '↑' : '↓'}
        </span>
      </button>

      <div
        role="group"
        aria-label={t('view.label')}
        className="flex h-9 shrink-0 items-center rounded-[10px] bg-[var(--bg)] p-0.5"
      >
        {(
          [
            ['grid', LayoutGrid, 'view.grid'],
            ['list', List, 'view.list']
          ] as const
        ).map(([view, Icon, label]) => (
          <button
            key={view}
            aria-pressed={tab.view === view}
            onClick={() => patch({ view })}
            title={t(label)}
            aria-label={t(label)}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-lg',
              tab.view === view
                ? 'bg-[var(--sf)] text-[var(--tx)] shadow-sm'
                : 'text-[var(--mu)] hover:text-[var(--tx)]'
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
          </button>
        ))}
      </div>
      <button
        className={iconBtn}
        onClick={onNewFolder}
        disabled={!canWrite}
        title={t('explorer.newFolderTooltip')}
        aria-label={t('explorer.newFolder')}
      >
        <FolderPlus className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
      </button>
      <button
        className={cn(iconBtn, railTab === 'info' && 'bg-[var(--acw)] text-[var(--ac)]')}
        aria-pressed={railTab === 'info'}
        onClick={() => useShelfStore.getState().setRailTab(railTab === 'info' ? 'shelf' : 'info')}
        title={t('explorer.detailsTooltip')}
        aria-label={t('explorer.details')}
      >
        <Info className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
      </button>

      {menu && (
        <ItemMenu
          x={menu.x}
          y={menu.y}
          label={menu.label}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
