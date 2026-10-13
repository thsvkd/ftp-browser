import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes } from 'react'
import {
  ArrowDownAZ,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  FolderOpen,
  FolderPlus,
  Info,
  LayoutGrid,
  List,
  ListFilter,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { useLocale, useT, type MessageKey } from '@renderer/i18n'
import type { SortKey } from '@renderer/lib/entryList'
import { locKey, parentPath, type ExplorerEntry, type Loc } from '@renderer/lib/explorerEntry'
import { fitCrumbs, pathCrumbs, type Crumb } from '@renderer/lib/pathCrumbs'
import { SPRING_MS } from '@renderer/lib/explorerLayout'
import {
  PATH_TOOL_ORDER,
  fitPathTools,
  type PathBarFit,
  type PathToolId
} from '@renderer/lib/pathBarTools'
import { sourceLabel } from '@renderer/lib/sendItems'
import { cn } from '@renderer/lib/utils'
import { useListingStore } from '@renderer/stores/useListingStore'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useTabsStore, type Tab } from '@renderer/stores/useTabsStore'
import { SourceBadge } from '@renderer/components/common/SourceBadge'
import { useDropTarget } from './dnd'
import { useFilterSummary } from '@renderer/hooks/useFileFilter'
import { FileFilterMenu, FilterTriggerPlaceholder } from './FileFilterMenu'
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
    useTabsStore.getState().navigate(loc, { tabId: tab.id })
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
 * 놓기 대상인 경로 조각(Test-827): 놓으면 그 폴더로 보내고, 머무르면 그 탭(`tabId`)을 연다. 지금 폴더의
 * 조각은 받지 않는다. 끄는 동안 무엇을 할지(동사)를 조각 안에 보인다. 놓기 키에 탭 id가 있어 두 패널의
 * 같은 조각이 함께 강조되지 않는다(split-view P9).
 */
function DropCrumb({
  tabId,
  loc,
  current,
  className,
  title,
  children,
  ...rest
}: {
  tabId: string
  loc: Loc
  current?: boolean
} & ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  const drop = useDropTarget(`crumb:${tabId}:${locKey(loc)}`, current ? null : loc, {
    spring: () => useTabsStore.getState().navigate(loc, { tabId }),
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
  tabId,
  loc,
  onEdit,
  onMenu
}: {
  tabId: string
  loc: Loc
  onEdit: () => void
  /** `opener`는 "…" 버튼, `keyboard`는 Enter·Space로 눌렀는가(click의 detail 0, X12) */
  onMenu: (x: number, y: number, hidden: Crumb[], opener: HTMLElement, keyboard: boolean) => void
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
  const nav = (path: string): void => useTabsStore.getState().navigate({ ...loc, path }, { tabId })
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
          tabId={tabId}
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
                onMenu(r.left, r.bottom + 4, hidden, e.currentTarget, e.detail === 0)
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
                tabId={tabId}
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
  /** 분할 보기의 비활성 패널: 글자를 흐리게(split-view F13) */
  dim?: boolean
  editing: boolean
  onEditingChange: (editing: boolean) => void
  /** 찾기 칸이 열렸는가(Ctrl+F·돋보기·⋯의 찾기). 열림이 거짓에서 참이 되면 칸에 포커스를 준다(X7) */
  searchOpen: boolean
  onSearchOpenChange: (open: boolean) => void
  /** 현재 폴더의 목록(숨김 파일 설정 반영, 찾기·필터 전). 필터 드롭다운의 개수 기준이다. */
  entries: readonly ExplorerEntry[]
  /** 찾기를 통과했지만 파일 종류 필터로 빠진 수 */
  filterHidden: number
  canWrite: boolean
  onNewFolder: () => void
  onReload: () => void
}

const sortBtn =
  'flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-semibold text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]'
const searchBox = (compact: boolean): string =>
  cn('relative flex h-9 shrink-0 items-center', compact ? 'w-[150px]' : 'w-[200px]')

/**
 * 경로 막대: ‹ › ↑, 접히는 조각(빈 곳·Ctrl+L로 입력), 찾기, 파일 종류 필터, 정렬, 보기, 새 폴더, 세부 정보.
 * 어느 폭에서도 한 줄이다. 들어가지 않는 도구는 오른쪽 끝의 ⋯ 메뉴로 접는다(explorer-ux-polish X1~X9):
 * 보이지 않는 측정 줄에 지금 모양의 도구를 그려 폭을 재고 `fitPathTools`로 고른다.
 */
export function PathBar({
  tab,
  dim = false,
  editing,
  onEditingChange,
  searchOpen,
  onSearchOpenChange,
  entries,
  filterHidden,
  canWrite,
  onNewFolder,
  onReload
}: PathBarProps): React.JSX.Element {
  const t = useT()
  const locale = useLocale()
  const railTab = useShelfStore((s) => s.railTab)
  const barRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  // ⋯ 버튼. 접힌 필터 팝오버의 기준 요소다.
  const [moreEl, setMoreEl] = useState<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [compact, setCompact] = useState(false)
  // `forSearch`: 이 결과를 잰 찾기 모양(열린 칸이면 참). 지금 `showSearch`와 같아야 칸 자리가 확정이다.
  const [fit, setFit] = useState<(PathBarFit & { forSearch: boolean }) | null>(null)
  // 접힌 필터의 팝오버(⋯ 아래)
  const [filterOpen, setFilterOpen] = useState(false)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    items: MenuItem[]
    label: string
    /** Enter·Space로 연 메뉴: 첫 사용 가능한 항목에 포커스(X12) */
    focusFirst: boolean
  } | null>(null)
  // 메뉴를 연 버튼과, 메뉴가 Esc로 닫혔는가. Esc로 닫히면 연 버튼으로 포커스를 돌려준다(X9).
  const opener = useRef<HTMLElement | null>(null)
  const escaped = useRef(false)
  const openMenu = (
    el: HTMLElement,
    m: { x: number; y: number; items: MenuItem[]; label: string; focusFirst: boolean }
  ): void => {
    opener.current = el
    escaped.current = false
    setMenu(m)
  }
  const closeMenu = (reason?: 'replaced'): void => {
    setMenu(null)
    if (reason !== 'replaced' && escaped.current) opener.current?.focus()
    escaped.current = false
  }
  const patch = (p: Partial<Tab>): void => useTabsStore.getState().patchTab(tab.id, p)
  const { loc, sort } = tab
  const { count: filterCount, title: filterTitle } = useFilterSummary(tab.filter, filterHidden)
  const showSearch = !compact || searchOpen || !!tab.query

  // 측정 줄의 폭으로 접을 도구를 고른다(X5). 막대 폭이 0이면(레이아웃 없음) 모두 보인다.
  const remeasure = useRef<() => void>(() => undefined)
  useLayoutEffect(() => {
    remeasure.current = () => {
      const bar = barRef.current
      const row = measureRef.current
      if (!bar || !row) return
      const width = (id: string): number =>
        row.querySelector<HTMLElement>(`[data-measure="${id}"]`)?.offsetWidth ?? 0
      setFit({
        ...fitPathTools(
          {
            bar: bar.clientWidth,
            back: width('back'),
            up: width('up'),
            more: width('more'),
            tools: Object.fromEntries(PATH_TOOL_ORDER.map((id) => [id, width(id)])) as Record<
              PathToolId,
              number
            >
          },
          showSearch
        ),
        forSearch: showSearch
      })
    }
  })
  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const update = (): void => {
      setCompact(bar.clientWidth > 0 && bar.clientWidth < 900)
      // 막대는 늘 한 줄이지만 바쁨 막대·놓기 테두리가 이 값을 따른다(Explorer의 `--path-bar-h`).
      bar.parentElement?.style.setProperty('--path-bar-h', `${bar.offsetHeight || 52}px`)
      remeasure.current()
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [])
  // 도구 모양이 바뀌면 다시 잰다(좁음 여부, 필터 개수, 찾기 열림, 정렬 키·방향, 로캘).
  useLayoutEffect(() => {
    remeasure.current()
  }, [compact, filterCount, showSearch, sort.key, sort.dir, locale])

  // 찾기가 열리면 칸에 포커스를 준다. 칸은 다시 잰 뒤에야 그려질 수 있어 그려질 때까지 기다린다(X7).
  // 열린 칸으로 다시 재기 전의 칸은 다음 그리기에서 조각 자리로 옮겨 가며 새로 그려질 수 있으므로(X6),
  // 지금 모양으로 잰 결과가 나온 뒤에만 포커스한다.
  const focusSearch = useRef(false)
  useLayoutEffect(() => {
    focusSearch.current = searchOpen
  }, [searchOpen])
  useLayoutEffect(() => {
    if (focusSearch.current && searchRef.current && fit?.forSearch === showSearch) {
      focusSearch.current = false
      searchRef.current.focus()
    }
  })

  const shownSet = new Set<PathToolId>(fit?.shown ?? PATH_TOOL_ORDER)
  const shown = (id: PathToolId): boolean => shownSet.has(id)
  const overflow = fit?.overflow ?? []
  const searchInSlot = !!fit?.searchInSlot && showSearch
  const filterFolded = !shown('filter')
  // 접힌 필터의 열림은 접혀 있는 동안만 뜻이 있다. 펴지면 잊어야 다시 접힐 때 저절로 열리지 않는다.
  if (!filterFolded && filterOpen) setFilterOpen(false)
  const moreOpen = menu?.label === t('path.moreTools')

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
  const toggleInfo = (): void =>
    useShelfStore.getState().setRailTab(railTab === 'info' ? 'shelf' : 'info')

  // ⋯ 메뉴: 접힌 도구만, 막대에 놓이는 순서로(X8)
  const moreItems = (): MenuItem[] =>
    overflow.flatMap((id): MenuItem[] => {
      switch (id) {
        case 'forward':
          return [
            {
              label: t('explorer.forward'),
              icon: ChevronRight,
              shortcut: 'Alt+→',
              disabled: !tab.fwd.length,
              onSelect: () => useTabsStore.getState().goForward(tab.id)
            }
          ]
        case 'reload':
          return [
            { label: t('toolbar.refresh'), icon: RefreshCw, shortcut: 'F5', onSelect: onReload }
          ]
        case 'search':
          return [
            {
              label: t('filter.find'),
              icon: Search,
              shortcut: 'Ctrl+F',
              onSelect: () => onSearchOpenChange(true)
            }
          ]
        case 'filter':
          return [
            {
              label: t('filter.button'),
              icon: ListFilter,
              hint: filterCount > 0 ? filterTitle : undefined,
              onSelect: () => setFilterOpen(true)
            }
          ]
        case 'sort':
          return [{ label: t('sort.label'), icon: ArrowUpDown, submenu: sortItems }]
        case 'view':
          return (['grid', 'list'] as const).map((view) => ({
            label: t(view === 'grid' ? 'view.grid' : 'view.list'),
            icon: tab.view === view ? Check : undefined,
            onSelect: () => patch({ view })
          }))
        case 'newFolder':
          return [
            {
              label: t('explorer.newFolder'),
              icon: FolderPlus,
              shortcut: 'Ctrl+Shift+N',
              disabled: !canWrite,
              onSelect: onNewFolder
            }
          ]
        case 'info':
          return [
            {
              label: t('explorer.details'),
              icon: railTab === 'info' ? Check : undefined,
              shortcut: 'Alt+Shift+P',
              onSelect: toggleInfo
            }
          ]
      }
    })

  const searchField = (inSlot: boolean): React.JSX.Element => (
    <label
      className={inSlot ? 'relative flex h-7 min-w-0 flex-1 items-center' : searchBox(compact)}
    >
      <Search
        className="pointer-events-none absolute left-2.5 h-4 w-4 text-[var(--mu)]"
        aria-hidden
      />
      <input
        ref={searchRef}
        id={`explorer-filter-${tab.id}`}
        onBlur={() => onSearchOpenChange(false)}
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
        className={cn(
          'h-full w-full border border-[var(--bd)] bg-[var(--bg)] pl-8 pr-7 text-[13px] text-[var(--tx)] outline-none placeholder:text-[var(--mu)] focus:border-[var(--ac)] focus:bg-[var(--sf)]',
          inSlot ? 'rounded-md' : 'rounded-[10px]'
        )}
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
  )

  return (
    <div
      ref={barRef}
      data-dim={dim ? 'true' : undefined}
      className="path-bar relative flex min-h-[52px] shrink-0 items-center gap-1.5 border-b border-[var(--bd)] px-3 py-2"
      // 메뉴는 이 막대 안에 그려지므로 그 Esc를 메뉴보다 먼저 본다(X9).
      onKeyDownCapture={(e) => {
        if (menu && e.key === 'Escape') escaped.current = true
      }}
    >
      <button
        className={iconBtn}
        disabled={!tab.back.length}
        onClick={() => useTabsStore.getState().goBack(tab.id)}
        title={t('path.backTooltip')}
        aria-label={t('explorer.back')}
      >
        <ChevronLeft className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
      </button>
      {shown('forward') && (
        <button
          className={iconBtn}
          disabled={!tab.fwd.length}
          onClick={() => useTabsStore.getState().goForward(tab.id)}
          title={t('path.forwardTooltip')}
          aria-label={t('explorer.forward')}
        >
          <ChevronRight className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
        </button>
      )}
      <button
        className={iconBtn}
        disabled={parentPath(loc.side, loc.path) === null}
        onClick={() => useTabsStore.getState().goUp(tab.id)}
        title={t('path.upTooltip')}
        aria-label={t('path.up')}
      >
        <ArrowUp className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
      </button>

      <div className="relative ml-1 flex h-9 min-w-0 flex-1 items-center overflow-hidden rounded-[10px] border border-[var(--bd)] bg-[var(--bg)] pl-1.5 pr-1">
        {editing ? (
          <PathInput tab={tab} onDone={() => onEditingChange(false)} />
        ) : searchInSlot ? (
          // 들어가지 않는 열린 찾기 칸은 조각 자리를 대신한다(X6). 경로 입력이 먼저다.
          searchField(true)
        ) : (
          <Crumbs
            tabId={tab.id}
            loc={loc}
            onEdit={() => onEditingChange(true)}
            onMenu={(x, y, hidden, el, keyboard) =>
              openMenu(el, {
                x,
                y,
                focusFirst: keyboard,
                label: t('path.hidden'),
                items: hidden.map((c) => ({
                  label: c.name,
                  icon: FolderOpen,
                  onSelect: () =>
                    useTabsStore.getState().navigate({ ...loc, path: c.path }, { tabId: tab.id })
                }))
              })
            }
          />
        )}
        {shown('reload') && (
          <button
            className={cn(iconBtn, 'h-7 w-7')}
            onClick={onReload}
            title={t('toolbar.refreshTooltip')}
            aria-label={t('toolbar.refresh')}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>

      {/* 찾기·필터·정렬·보기·새 폴더·정보와 ⋯. 들어가지 않는 도구는 ⋯로 접힌다(X1). */}
      <div data-path-tools className="ml-auto flex shrink-0 items-center justify-end gap-1.5">
        {shown('search') &&
          !searchInSlot &&
          (showSearch ? (
            searchField(false)
          ) : (
            <button
              id={`explorer-filter-${tab.id}`}
              className={cn(iconBtn, 'h-9 w-9')}
              onClick={() => onSearchOpenChange(true)}
              title={t('filter.findTooltip')}
              aria-label={t('filter.find')}
            >
              <Search className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
            </button>
          ))}

        <FileFilterMenu
          tab={tab}
          entries={entries}
          hiddenCount={filterHidden}
          compact={compact}
          folded={
            filterFolded
              ? { anchor: moreEl, open: filterOpen, onOpenChange: setFilterOpen }
              : undefined
          }
        />

        {shown('sort') && (
          <button
            className={sortBtn}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              openMenu(e.currentTarget, {
                x: r.right - 232,
                y: r.bottom + 4,
                items: sortItems,
                label: t('sort.label'),
                focusFirst: e.detail === 0
              })
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
        )}

        {shown('view') && (
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
        )}
        {shown('newFolder') && (
          <button
            className={iconBtn}
            onClick={onNewFolder}
            disabled={!canWrite}
            title={t('explorer.newFolderTooltip')}
            aria-label={t('explorer.newFolder')}
          >
            <FolderPlus className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
          </button>
        )}
        {shown('info') && (
          <button
            className={cn(iconBtn, railTab === 'info' && 'bg-[var(--acw)] text-[var(--ac)]')}
            aria-pressed={railTab === 'info'}
            onClick={toggleInfo}
            title={t('explorer.detailsTooltip')}
            aria-label={t('explorer.details')}
          >
            <Info className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
          </button>
        )}
        {overflow.length > 0 && (
          <button
            ref={setMoreEl}
            className={cn(iconBtn, 'relative')}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            // 접힌 필터가 켜져 있으면 숨은 항목이 있다는 신호를 ⋯에 남긴다(X8).
            data-active={filterFolded && filterCount > 0 ? 'true' : undefined}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              openMenu(e.currentTarget, {
                x: r.right - 232,
                y: r.bottom + 4,
                items: moreItems(),
                label: t('path.moreTools'),
                focusFirst: e.detail === 0
              })
            }}
            title={t('path.moreTools')}
            aria-label={t('path.moreTools')}
          >
            <Ellipsis className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
            {filterFolded && filterCount > 0 && (
              <span
                aria-hidden
                className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--ac)]"
              />
            )}
          </button>
        )}
      </div>

      {/* 도구 폭을 재는 보이지 않는 줄(X5): 지금 모양의 자리표시자. id·이름·이벤트가 없다(함정 2). */}
      <div
        ref={measureRef}
        data-path-measure
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 flex w-max whitespace-nowrap"
      >
        <span data-measure="back" className={iconBtn} />
        <span data-measure="up" className={iconBtn} />
        <span data-measure="more" className={iconBtn} />
        <span data-measure="forward" className={iconBtn} />
        <span data-measure="reload" className={cn(iconBtn, 'h-7 w-7')} />
        <span
          data-measure="search"
          className={showSearch ? searchBox(compact) : cn(iconBtn, 'h-9 w-9')}
        />
        <FilterTriggerPlaceholder compact={compact} count={filterCount} />
        <span data-measure="sort" className={sortBtn}>
          <ArrowUpDown className="h-4 w-4" />
          {!compact && <span>{t(SORT_LABEL[sort.key])}</span>}
          <span className="mono text-[11px]">{sort.dir === 'asc' ? '↑' : '↓'}</span>
        </span>
        <span data-measure="view" className="flex h-9 shrink-0 items-center rounded-[10px] p-0.5">
          <span className="h-8 w-8" />
          <span className="h-8 w-8" />
        </span>
        <span data-measure="newFolder" className={iconBtn} />
        <span data-measure="info" className={iconBtn} />
      </div>

      {menu && (
        <ItemMenu
          x={menu.x}
          y={menu.y}
          label={menu.label}
          items={menu.items}
          focusFirst={menu.focusFirst}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}
