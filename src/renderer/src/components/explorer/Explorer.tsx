import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  Clipboard,
  Eye,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Info,
  Loader,
  PackageCheck,
  PackageMinus,
  PackagePlus,
  Pencil,
  RefreshCw,
  Send,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '@renderer/i18n'
import { useElementWidth } from '@renderer/hooks/useElementWidth'
import { useAllCategories, useCategoryName, useTabMatcher } from '@renderer/hooks/useFileFilter'
import { useTypeAhead } from '@renderer/hooks/useTypeAhead'
import { shouldDeferToNativeContextMenu } from '@renderer/lib/debugTools'
import { filterEntries, sortEntries } from '@renderer/lib/entryList'
import {
  joinPath,
  locKey,
  parentPath,
  type ExplorerEntry,
  type Loc
} from '@renderer/lib/explorerEntry'
import { LABEL_H, PAD, ROW, optId } from '@renderer/lib/explorerLayout'
import { EMPTY_FILTER, filterLabel } from '@renderer/lib/fileCategories'
import { flyTo, sourcesFor } from '@renderer/lib/flyTo'
import { gridLayout } from '@renderer/lib/gridGeometry'
import { currentPlatform } from '@renderer/lib/platform'
import { clampRatio } from '@renderer/lib/splitLayout'
import {
  clearSelection,
  clickSelect,
  moveFocus,
  navIndex,
  selectAll,
  selectMany,
  toggleSelect,
  type SelectionState
} from '@renderer/lib/selectionModel'
import { planSend } from '@renderer/lib/sendPlan'
import { isPendingConnect } from '@renderer/lib/splitConnect'
import {
  connectToServer,
  dropShelf,
  loadPlaces,
  locLabel,
  sendDestinations,
  sendItems,
  sourceLabel
} from '@renderer/lib/sendItems'
import {
  payloadOf,
  savedServerOf,
  useConnStatus,
  useConnectedKeys
} from '@renderer/lib/connections'
import { cn } from '@renderer/lib/utils'
import { confirmDelete } from '@renderer/stores/useConfirmStore'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useGalleryStore } from '@renderer/stores/useGalleryStore'
import { useListingStore } from '@renderer/stores/useListingStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useTabsStore, visiblePanes, type Split, type Tab } from '@renderer/stores/useTabsStore'
import { isSafeLocalName, isSafeRemoteName, uniqueLocalNames } from '@shared/entryName'
import type { IpcResult } from '@shared/types/ipc'
import { startDrag, useDnd, useDropTarget, useSplitDropTarget } from './dnd'
import { DragGhost } from './DragGhost'
import {
  EmptyPanel,
  ListErrorPanel,
  LostPanel,
  OfflinePanel,
  ServerOfflinePanel,
  Skeleton,
  StaleBanner
} from './ExplorerStates'
import { FileGrid, ZOOM_STEP } from './FileGrid'
import { FileList } from './FileList'
import { ItemMenu, type MenuItem } from './ItemMenu'
import { Lightbox } from './Lightbox'
import { ListHeader } from './ListHeader'
import { PaneIdContext, usePaneId } from './paneContext'
import { PathBar } from './PathBar'
import { PropertiesDialog } from './PropertiesDialog'
import { SplitDivider } from './SplitDivider'
import { SplitOverlay } from './SplitOverlay'
import type { ItemProps } from './useItem'

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

const NONE: ExplorerEntry[] = []

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * 원격 탭의 처지(MC11): 그 탭의 서버(`loc.server`) 연결로 정한다. 연결됐으면 목록을 읽고(live),
 * 연결 중이면 회전 표시 패널(connecting), 끊겼으면 지난 목록(stale)이나 끊김 패널(lost), 연결이
 * 없으면 그 서버에 연결하는 패널(offline).
 */
type Gate = 'live' | 'connecting' | 'stale' | 'lost' | 'offline'

/**
 * 자동 연결(MC12): 저장된 비밀번호가 있는 저장 서버의 원격 탭이 보이기 시작할 때(탐색 영역 마운트,
 * 탭의 서버가 바뀔 때) 그 서버가 연결 안 됨이면 한 번 연결한다. 상태 변화에는 반응하지 않는다:
 * 보는 중에 끊으면 다시 잇지 않는다. 끊김(error)·연결 중도 잇지 않는다. 툴바는 건드리지 않는다.
 */
function useAutoConnect(tab: Tab): void {
  const server = tab.loc.side === 'remote' ? tab.loc.server : undefined
  useEffect(() => {
    if (!server) return
    // 분할 연결이 곧 시작될 자리표시자 탭: 그 시도가 자동 연결과 겹치지 않게 한다(함정 I·P-C3).
    if (isPendingConnect(server)) return
    const status = useFtpStore.getState().connections[server]?.status ?? 'disconnected'
    if (status !== 'disconnected') return
    const saved = savedServerOf(useServerStore.getState().servers, server)
    if (!saved?.hasPassword) return
    void useFtpStore.getState().connect(payloadOf(saved), tab.loc.path, { adopt: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 계기는 탭과 서버뿐이다(함정 10)
  }, [tab.id, server])
}

/** 분할 루트의 폭. 분할이 보이기 시작할 때와 크기가 바뀔 때 잰다(비율을 자르는 기준, P8). */
function useSplitWidth(ref: React.RefObject<HTMLElement | null>, shown: boolean): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !shown) return
    const measure = (): void => setWidth(el.getBoundingClientRect().width)
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [ref, shown])
  return width
}

type Entering = Record<string, 'grow' | 'in'>

/**
 * 패널의 렌더 순서: 탭을 만든 순서(`tab<N>`의 N). 문자열로 견주면 tab10이 tab9보다 앞선다. 좌우 바꾸기
 * 뒤에는 이 순서(곧 Tab 키·낭독 순서)가 화면 순서와 다를 수 있다(P10의 대가, split-view §14).
 */
const bySeq = (a: string, b: string): number => {
  const seq = (id: string): number => Number(/\d+$/.exec(id)?.[0] ?? NaN)
  return seq(a) - seq(b) || (a < b ? -1 : 1)
}

/**
 * M15: 서버 행을 끌고 있는 동안 콘텐츠 영역을 반으로 나눈 놓기 자리. 호버한 쪽만 하이라이트와
 * `split.dropHint`를 보여주고, 놓으면 그쪽 패널부터 만든다(함정 F — 놓기에서, 스프링이 아니라).
 */
function SplitHalf({ side }: { side: 'left' | 'right' }): React.JSX.Element {
  const t = useT()
  const { over, handlers } = useSplitDropTarget(`split:${side}`, side)
  return (
    <div
      data-testid={`split-${side}`}
      {...handlers}
      className={cn('relative flex w-1/2 items-center justify-center', over && 'bg-[var(--acw)]')}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-3 rounded-xl border-2 transition-colors',
          over ? 'border-[var(--ac)]' : 'border-transparent'
        )}
      />
      {over && (
        <span className="pop pointer-events-none rounded-full border-2 border-[var(--ac)] bg-[var(--sf)] px-4 py-2 text-[13px] font-semibold text-[var(--tx)] shadow-lg">
          {t('split.dropHint')}
        </span>
      )}
    </div>
  )
}

/**
 * 탐색 영역: 보이는 패널(`visiblePanes`)마다 `TabExplorer` 하나. 분할이 보이면 두 패널 사이에 구분선을
 * 둔다(split-view §3.4). 렌더 순서는 탭 id로 고정하고 좌우는 `style.order`로만 정해, 좌우 바꾸기·분할
 * 진입에도 패널을 다시 마운트하지 않는다(P10, 함정 5). 탭이 바뀌어 다시 마운트되면(탭 id가 key) 메뉴·이름
 * 바꾸기 같은 지역 상태가 다른 탭으로 새지 않는다. 시작 직후 탭이 없으면 아무것도 그리지 않는다.
 */
export function Explorer(): React.JSX.Element | null {
  const tabs = useTabsStore((s) => s.tabs)
  const activeId = useTabsStore((s) => s.activeId)
  const split = useTabsStore((s) => s.split)
  // M15: 서버 행을 끌고 있는 동안만 콘텐츠 절반의 놓기 자리가 뜬다(항목·OS 드래그와 구분된다).
  const serverDrag = useDnd((s) => s.server !== null)
  const panes = visiblePanes({ tabs, activeId, split }).flatMap((p) => {
    const tab = tabs.find((x) => x.id === p.tabId)
    return tab ? [{ ...p, tab }] : []
  })
  const shown = panes.length === 2
  const rootRef = useRef<HTMLDivElement>(null)
  const width = useSplitWidth(rootRef, shown)

  // 새 분할이 생기면 원래 보이던 패널은 100%에서, 새 패널은 0에서 비율로 한 번 자리 잡는다(§5).
  const ids = panes.map((p) => p.tab.id).join('|')
  const [seen, setSeen] = useState<{ split: Split | null; ids: string }>({ split, ids })
  const [entering, setEntering] = useState<Entering | null>(null)
  if (seen.split !== split || seen.ids !== ids) {
    const before = seen.ids.split('|')
    setSeen({ split, ids })
    setEntering(
      shown && before.length === 1 && seen.split !== split
        ? Object.fromEntries(
            panes.map((p) => [p.tab.id, before.includes(p.tab.id) ? 'grow' : 'in'])
          )
        : null
    )
  }

  if (!panes.length) return null
  // 그리는 비율은 저장값을 지금 폭으로 자른 값이다(창이 다시 커지면 원래 비율이 살아난다).
  const ratio = shown && split ? clampRatio(split.ratio, width) : 1
  const leftPct = Math.round(ratio * 10000) / 100
  return (
    <div ref={rootRef} data-split-root className="relative flex min-h-0 min-w-0 flex-1">
      {[...panes]
        .sort((a, b) => bySeq(a.tab.id, b.tab.id))
        .map(({ pane, tab }) => (
          <PaneIdContext.Provider key={tab.id} value={pane}>
            <TabExplorer
              tab={tab}
              split={shown}
              active={tab.id === activeId}
              basis={
                shown ? (pane === 'left' ? leftPct : Math.round((100 - leftPct) * 100) / 100) : null
              }
              entering={entering?.[tab.id]}
              onSettled={() => setEntering(null)}
            />
          </PaneIdContext.Provider>
        ))}
      {shown && <SplitDivider ratio={ratio} rootRef={rootRef} order={1} />}
      {/* M15: 서버 드래그 동안의 놓기 자리 — 콘텐츠 영역을 왼쪽/오른쪽 절반으로 나눈다. */}
      {serverDrag && (
        <div data-testid="split-zones" className="absolute inset-0 z-30 flex">
          <SplitHalf side="left" />
          <SplitHalf side="right" />
        </div>
      )}
      <SplitOverlay />
      <DragGhost />
    </div>
  )
}

/** 패널 id는 `PaneIdContext`(`usePaneId`)로 받는다(P2). */
interface TabExplorerProps {
  tab: Tab
  /** 분할이 보인다: 항목 id에 탭 범위를 붙이고 영역 이름을 패널 이름으로(P9·P12) */
  split: boolean
  /** 활성 패널(분할이 아니면 늘 참) */
  active: boolean
  /** 분할에서의 flex-basis(%) */
  basis: number | null
  entering: 'grow' | 'in' | undefined
  onSettled: () => void
}

function TabExplorer({
  tab,
  split,
  active,
  basis,
  entering,
  onSettled
}: TabExplorerProps): React.JSX.Element {
  const t = useT()
  const paneId = usePaneId()
  // DOM id 범위(P9): 분할이 보일 때만 탭 id. 단일 보기의 id는 지금과 같다.
  const scope = split ? tab.id : undefined
  const { loc } = tab
  const key = locKey(loc)
  const remote = loc.side === 'remote'
  const listing = useListingStore((s) => s.byKey[key])
  const status = useConnStatus(remote ? loc.server : undefined)
  const connected = useConnectedKeys()
  const showHidden = useSettingsStore((s) => s.showHidden)
  const tileSize = useSettingsStore((s) => s.tileSize)
  const shelfKeys = useShelfStore((s) => s.items.map((i) => locKey(i.entry)).join('\n'))
  const shelfCount = useShelfStore((s) => s.items.length)
  const dragging = useDnd((s) => s.items !== null)
  const patch = (p: Partial<Tab>): void => useTabsStore.getState().patchTab(tab.id, p)

  const cached = !!listing && (listing.status === 'ready' || listing.entries.length > 0)
  // P-C3: 분할 연결 대기(시도 전·대기열)인 키는 게이트가 "연결 중"을 그린다(M16 ①).
  const pendingConnect = isPendingConnect(remote ? loc.server : undefined)
  const gate: Gate = !remote
    ? 'live'
    : status === 'connected'
      ? 'live'
      : status === 'connecting' || (pendingConnect && status === 'disconnected')
        ? 'connecting'
        : status === 'error'
          ? cached
            ? 'stale'
            : 'lost'
          : 'offline'
  useAutoConnect(tab)

  // 새 폴더를 읽는 동안에는 이 탭에서 마지막으로 보인 폴더의 목록을 흐리게 둔다.
  const [shownKey, setShownKey] = useState<string | null>(null)
  if (gate === 'live' && listing?.status === 'ready' && shownKey !== key) setShownKey(key)
  const shown = useListingStore((s) => (shownKey ? s.byKey[shownKey] : undefined))

  const firstLoad = !listing || (listing.status === 'loading' && !listing.entries.length)
  const mode: 'live' | 'pending' | 'skeleton' | 'error' | 'stale' | 'panel' =
    gate === 'stale'
      ? 'stale'
      : gate !== 'live'
        ? 'panel'
        : firstLoad
          ? shown && shownKey !== key
            ? 'pending'
            : 'skeleton'
          : listing.status === 'error'
            ? 'error'
            : 'live'
  const base =
    (mode === 'live' || mode === 'stale'
      ? listing?.entries
      : mode === 'pending'
        ? shown?.entries
        : undefined) ?? NONE
  const interactive = mode === 'live' || mode === 'stale'
  const dimmed =
    mode === 'pending' || mode === 'stale' || (mode === 'live' && !!listing?.refreshing)

  const matcher = useTabMatcher(tab.filter)
  const allCategories = useAllCategories()
  const nameOfCategory = useCategoryName()
  const filterText = filterLabel(tab.filter, allCategories, nameOfCategory, t('filter.noExtension'))
  // 필터 드롭다운의 개수 기준: 숨김 파일 설정은 반영하고 찾기는 반영하지 않는다(E19).
  const listable = useMemo(
    () => (showHidden ? base : base.filter((e) => !e.hidden)),
    [base, showHidden]
  )
  const filtered = useMemo(() => {
    const f = filterEntries(base, { query: tab.query, matcher, showHidden })
    return { ...f, visible: sortEntries(f.visible, tab.sort) }
  }, [base, tab.query, matcher, showHidden, tab.sort])
  const items = filtered.visible
  // 이름 충돌은 가려진 항목까지 본다(rename-name-taken N2)
  const folderNames = useMemo(() => new Set(base.map((e) => e.name)), [base])
  const paths = useMemo(() => items.map((e) => e.path), [items])
  const indexOf = useMemo(() => new Map(paths.map((p, i) => [p, i])), [paths])
  const files = useMemo(() => items.filter((e) => e.type === 'file'), [items])
  const selSet = useMemo(() => new Set(tab.sel), [tab.sel])
  const selected = useMemo(() => items.filter((e) => selSet.has(e.path)), [items, selSet])
  const shelved = useMemo(() => new Set(shelfKeys.split('\n')), [shelfKeys])
  // 선택 안의 작업 대상 항목(선택 = 포커스). 숨겨졌으면 없다. 첫 항목으로 대체하지 않는다.
  const focusPath = tab.focus && indexOf.has(tab.focus) ? tab.focus : null

  // ---------- 치수 ----------
  const scrollRef = useRef<HTMLDivElement>(null)
  const measured = useElementWidth(scrollRef)
  const width = measured ?? 0
  const grid = tab.view === 'grid'
  const layout = gridLayout(width, tileSize)
  const cols = grid ? layout.cols : 1
  const rowH = grid ? layout.rowHeight : ROW

  const ensureVisible = (i: number): void => {
    const el = scrollRef.current
    if (!el || i < 0) return
    const top = grid ? PAD + Math.floor(i / cols) * rowH : i * ROW
    const height = grid ? layout.imageHeight + LABEL_H : ROW
    if (top < el.scrollTop) el.scrollTop = Math.max(0, top - (grid ? PAD : 0))
    else if (top + height > el.scrollTop + el.clientHeight)
      el.scrollTop = top + height - el.clientHeight + (grid ? PAD : 0)
  }

  // ---------- 목록 읽기 ----------
  const reload = (): void => {
    if (gate === 'live') void useListingStore.getState().load(loc)
  }
  // 탭 전환(다시 마운트)은 캐시를 그대로 보이고, 이 탭 안의 이동·다시 연결은 읽는다.
  const settled = useRef(false)
  useEffect(() => {
    if (gate !== 'live') {
      settled.current = true
      return
    }
    const skip = !settled.current && useListingStore.getState().byKey[key]?.status === 'ready'
    settled.current = true
    if (!skip) void useListingStore.getState().load(loc)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loc은 key가 대신한다
  }, [key, gate])

  // 원격 위치가 바뀌면 대기 중인 썸네일·폴더 미리보기를 먼저 취소한다. layout effect라 그리드의
  // 새 배치(passive effect)보다 먼저 나간다(thumbnail-viewport-priority D14, 함정 2).
  const remoteKey = remote && gate === 'live' ? key : null
  const remoteServer = remote ? loc.server : undefined
  useLayoutEffect(() => {
    if (!remoteKey || !remoteServer) return
    // 이 패널(뷰어)의 대기만 취소한다. 서버가 바뀌는 이동일 수 있어 모든 연결에서(null) 뺀다(§4.3-4)
    window.api.invoke('thumbnail:cancelAll', null, paneId)
    window.api.invoke('gallery:cancelAll', null, paneId)
    useGalleryStore.getState().clearRemote(remoteServer)
  }, [remoteKey, remoteServer, paneId])
  // 뷰어 수명(split-view §4 17행 (b)): 패널이 사라지거나 패널 id가 바뀌면(좌우 바꾸기, 오른쪽이 활성인 채
  // 해제) 원격·live였던 옛 뷰어를 취소한다. layout 정리라 같은 커밋의 새 배치(passive)보다 먼저다(함정 7).
  const liveRemote = useRef(remoteKey)
  useLayoutEffect(() => {
    liveRemote.current = remoteKey
  })
  useLayoutEffect(
    () => () => {
      if (!liveRemote.current) return
      window.api.invoke('thumbnail:cancelAll', null, paneId)
      window.api.invoke('gallery:cancelAll', null, paneId)
    },
    [paneId]
  )

  useEffect(() => {
    void loadPlaces()
  }, [])

  // ---------- 스크롤 복원(탭+경로별, Tab.scroll) ----------
  // 다시 마운트되면 가상 목록은 다음 커밋에야 스크롤 요소를 잡고 그때 자기 오프셋(0)으로 스크롤한다.
  // 그래서 폭을 잰 다음 커밋(그 뒤)에 복원한다. 그리드 높이도 그때 맞다.
  const lastTop = useRef(0)
  const restoredFor = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (mode !== 'live' || !el || measured === null || restoredFor.current === key) return
    restoredFor.current = key
    const saved = tab.scroll[loc.path]
    el.scrollTop = saved ?? 0
    if (saved === undefined && tab.focus) ensureVisible(indexOf.get(tab.focus) ?? -1)
    lastTop.current = el.scrollTop
  })
  useLayoutEffect(() => {
    const path = loc.path
    const id = tab.id
    return () => {
      const top = lastTop.current
      useTabsStore.getState().patchTab(id, (x) => ({ scroll: { ...x.scroll, [path]: top } }))
    }
  }, [loc.path, tab.id])

  // 다른 것이 포커스를 갖고 있지 않으면 목록이 받는다(탭 전환 뒤, 함정 13). 두 패널이 함께 마운트되면
  // 활성 패널만 받는다(P7): 아니면 나중 패널이 포커스로 활성을 빼앗는다. 이미 마운트된 패널이 활성이
  // 되어도 본다: 포커스가 있던 활성 반쪽을 닫으면 그 목록과 함께 포커스가 사라진다(Ctrl+W·반쪽 닫기).
  useEffect(() => {
    if (active && document.activeElement === document.body)
      scrollRef.current?.focus({ preventScroll: true })
  }, [active])

  // ---------- 로딩 표시: 150ms 뒤 2px 막대, 1초 뒤 "Listing…" ----------
  const busy =
    (gate === 'live' && (listing?.status === 'loading' || !!listing?.refreshing)) ||
    gate === 'connecting'
  const [busyLevel, setBusyLevel] = useState(0)
  useEffect(() => {
    if (!busy) return
    const a = setTimeout(() => setBusyLevel(1), 150)
    const b = setTimeout(() => setBusyLevel(2), 1000)
    return () => {
      clearTimeout(a)
      clearTimeout(b)
      setBusyLevel(0)
    }
  }, [busy, key])

  // ---------- 오버레이 ----------
  const [menu, setMenu] = useState<{
    x: number
    y: number
    target: ExplorerEntry[]
    /** 메뉴 키·Shift+F10으로 열었다: 첫 사용 가능한 항목에 포커스(explorer-ux-polish X12) */
    keyboard?: boolean
  } | null>(null)
  const [props, setProps] = useState<ExplorerEntry | null>(null)
  const [lightbox, setLightbox] = useState<number | null>(null)
  /** 이름 입력 중인 항목. 그 항목을 고른 위치(`key`)와 함께 둔다: 다른 위치의 같은 경로에서 열리지 않는다. */
  const [renaming, setRenaming] = useState<{ key: string; path: string } | null>(null)
  const [editingPath, setEditingPath] = useState(false)
  // 찾기 칸의 열림. Ctrl+F가 연다. 찾기가 ⋯에 접혀도 막대가 칸을 그린다(explorer-ux-polish X7).
  const [searchOpen, setSearchOpen] = useState(false)
  const refocus = (): void => scrollRef.current?.focus({ preventScroll: true })
  const paneRef = useRef<HTMLElement>(null)
  // 편집하던 항목이 보이는 목록에서 사라지면(다른 위치로 이동, 다른 클라이언트의 삭제·이름 변경, 목록 오류, 찾기·필터에
  // 가려짐) 편집을 닫는다. 창이 비활성이라 편집이 열린 채 남아 있던 사이에도 생긴다. 같은 위치의 목록을 다시 읽는
  // 중에는 기다린다: 새 폴더를 만든 뒤 자기 목록 읽기가 다른 읽기에 밀리면 옛 목록이 잠시 남는다(rename-name-taken N10).
  const settling = mode === 'live' && !!listing?.refreshing
  // pending은 새 위치로 가는 중에 옛 목록을 보이는 것이라 그 항목은 이 위치의 것이 아니다(N11)
  const renameHere = renaming?.key === key && interactive
  const waitingRow = !!renaming && renameHere && settling && !indexOf.has(renaming.path)
  useEffect(() => {
    if (!renaming || (renameHere && (settling || indexOf.has(renaming.path)))) return
    setRenaming(null)
    if (document.activeElement === document.body) refocus()
  }, [renaming, renameHere, settling, indexOf])
  /** 사용자가 목록 밖의 입력 칸에서 치고 있다. 그때 새 폴더 입력이 열리면 치던 글자를 가로챈다(N11). */
  const typingElsewhere = (target: EventTarget | null): boolean =>
    isTyping(target) && !scrollRef.current?.contains(target as Node)
  // 기다리는 동안 사용자가 목록 밖의 입력 칸(찾기·경로 칸 등)이나 이 탐색기 밖으로 포커스를 옮기면, 늦게 열린 입력이
  // 포커스와 치던 글자를 빼앗지 않게 취소한다. 다른 앱에 다녀와 같은 요소로 포커스가 돌아온 것은 옮긴 것이 아니다(N9·N11).
  useEffect(() => {
    if (!waitingRow) return
    const before = document.activeElement
    const leaves = (target: EventTarget | null): boolean =>
      typingElsewhere(target) ||
      (target instanceof Element && target !== before && !paneRef.current?.contains(target))
    // 이미 다른 입력 칸에서 치고 있으면 기다리지 않는다
    if (leaves(before)) {
      setRenaming(null)
      return
    }
    const onFocusIn = (e: FocusEvent): void => {
      if (leaves(e.target)) setRenaming(null)
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [waitingRow])

  // ---------- 선택 ----------
  const selection: SelectionState = { sel: tab.sel, anchor: tab.anchor, focus: tab.focus }
  const selectOnly = (path: string): void => patch({ sel: [path], anchor: path, focus: path })
  const moveTo = (i: number, mods: { shift: boolean; ctrl: boolean }): void => {
    if (i < 0 || i >= items.length) return
    patch(moveFocus(selection, paths, i, mods))
    ensureVisible(i)
  }
  // 선택이 없으면 focus도 없다(I2): 대상은 선택뿐이다.
  const targetOf = (): ExplorerEntry[] => selected

  // ---------- 동작 ----------
  const locOf = (e: ExplorerEntry): Loc => ({
    side: e.side,
    path: e.path,
    ...(e.server ? { server: e.server } : {})
  })
  const open = (e: ExplorerEntry): void => {
    if (e.type === 'directory') useTabsStore.getState().navigate(locOf(e), { tabId: tab.id })
    else {
      const i = files.indexOf(e)
      if (i >= 0) setLightbox(i)
    }
  }
  const shelve = (entries: ExplorerEntry[]): void => {
    if (!entries.length) return
    const from = sourcesFor(
      entries.map((e) => e.path),
      scrollRef.current ?? document
    )
    if (!useShelfStore.getState().add(entries)) {
      toast(t('toast.alreadyOnShelf'))
      return
    }
    // 접힌 섬에는 놓기 대상 표시가 없다(shelf-island I4) — 섬 자체로 날아간다
    flyTo(from, document.querySelector('[data-shelf-target], [data-shelf-island]'))
  }
  const unshelve = (entries: ExplorerEntry[]): void =>
    useShelfStore.getState().remove(entries.map(locKey))

  const askDelete = async (entries: ExplorerEntry[]): Promise<void> => {
    if (!entries.length || !(await confirmDelete(entries))) return
    // 확인을 기다리는 동안 다른 폴더로 옮겨도 고른 시점의 경로를 지운다.
    const targets = entries.map((e) => ({ path: e.path, isDirectory: e.type === 'directory' }))
    try {
      const r = remote
        ? await window.api.invoke<IpcResult<void>>('ftp:deleteBatch', loc.server, targets)
        : await window.api.invoke<IpcResult<void>>('local:deleteBatch', targets)
      if (!r.success) toast.error(t('toast.deleteFailed'), { description: r.error })
    } catch (err) {
      toast.error(t('toast.deleteFailed'), { description: errorText(err) })
    } finally {
      unshelve(entries)
      patch(clearSelection())
      reload()
      refocus()
    }
  }

  const validName = (name: string): boolean => {
    if (remote ? isSafeRemoteName(name) : isSafeLocalName(name)) return true
    toast.error(t('toast.invalidName'), {
      description: t(remote ? 'name.invalidRemote' : 'name.invalidLocal')
    })
    return false
  }

  const commitRename = async (entry: ExplorerEntry, name: string | null): Promise<void> => {
    setRenaming(null)
    refocus()
    // 손대지 않은 원래 이름은 앞뒤 공백이 있어도 그대로 둔다
    if (name === entry.name) return
    const next = name?.trim()
    if (!next || next === entry.name || !validName(next)) return
    const target = joinPath(entry.side, parentPath(entry.side, entry.path) ?? loc.path, next)
    try {
      // 지금 탭의 위치가 아니라 그 항목이 나온 곳으로 보낸다(N11)
      const r =
        entry.side === 'remote'
          ? await window.api.invoke<IpcResult<void>>('ftp:rename', entry.server, entry.path, target)
          : await window.api.invoke<IpcResult<void>>('local:rename', entry.path, target)
      if (r.success) {
        unshelve([entry])
        selectOnly(target)
      } else toast.error(t('toast.renameFailed'), { description: r.error })
    } catch (err) {
      toast.error(t('toast.renameFailed'), { description: errorText(err) })
    } finally {
      reload()
    }
  }

  const newFolder = async (): Promise<void> => {
    if (mode !== 'live') return
    const names = base.map((e) => e.name)
    const name = uniqueLocalNames(
      [...names, t('explorer.newFolder')],
      remote ? 'linux' : currentPlatform()
    ).at(-1)
    if (!name) return
    const path = joinPath(loc.side, loc.path, name)
    try {
      const r = remote
        ? await window.api.invoke<IpcResult<void>>('ftp:mkdir', loc.server, path)
        : await window.api.invoke<IpcResult<void>>('local:mkdir', path)
      if (!r.success) {
        toast.error(t('toast.createFolderFailed'), { description: r.error })
        return
      }
    } catch (err) {
      toast.error(t('toast.createFolderFailed'), { description: errorText(err) })
      return
    }
    await useListingStore.getState().load(loc)
    selectOnly(path)
    // 만드는 사이 다른 입력 칸으로 가서 치고 있으면 이름 입력을 열지 않는다(N11)
    if (typingElsewhere(document.activeElement)) return
    // 만들기 시작한 위치의 항목만 편집한다(그사이 다른 위치로 옮겼으면 N10이 닫는다). 그사이 사용자가 다른 항목의
    // 이름 입력을 열었으면 그것을 덮지 않는다(N11).
    setRenaming((cur) => cur ?? { key, path })
  }

  const copyPaths = (list: string[]): void => {
    void navigator.clipboard?.writeText(list.join('\n')).catch(() => undefined)
    toast(t('toast.pathCopied', { count: list.length }))
  }

  // ---------- 메뉴 ----------
  const itemMenu = (target: ExplorerEntry[]): MenuItem[] => {
    const one = target.length === 1 ? target[0] : null
    const allShelved = target.every((e) => shelved.has(locKey(e)))
    return [
      one?.type === 'directory'
        ? { label: t('menu.open'), icon: FolderOpen, shortcut: 'Enter', onSelect: () => open(one) }
        : {
            label: t('menu.preview'),
            icon: Eye,
            shortcut: 'Space',
            disabled: !one,
            onSelect: () => one && open(one)
          },
      ...(one?.type === 'directory'
        ? [
            {
              label: t('menu.openInNewTab'),
              icon: FolderInput,
              onSelect: () => useTabsStore.getState().openTab(locOf(one), false)
            }
          ]
        : []),
      'sep',
      allShelved
        ? {
            label: t('menu.removeFromShelf'),
            icon: PackageMinus,
            shortcut: 'Shift+S',
            onSelect: () => unshelve(target)
          }
        : {
            label:
              target.length > 1
                ? t('menu.addManyToShelf', { number: target.length })
                : t('menu.addToShelf'),
            icon: PackagePlus,
            shortcut: 'Shift+S',
            onSelect: () => shelve(target)
          },
      {
        label: t('menu.sendTo'),
        icon: Send,
        submenu: sendDestinations(loc).map((dest) => {
          const plan = planSend(target, dest, connected)
          return {
            label: `${sourceLabel(dest)} › ${locLabel(dest)}`,
            icon: dest.side === 'remote' ? Send : FolderInput,
            disabled: !!plan.invalid,
            hint: plan.invalid ? t(plan.invalid) : dest.path,
            onSelect: () => void sendItems(target, dest)
          }
        })
      },
      'sep',
      {
        label: t('menu.rename'),
        icon: Pencil,
        shortcut: 'F2',
        disabled: !one || !interactive,
        onSelect: () => one && interactive && setRenaming({ key, path: one.path })
      },
      {
        label: t('menu.copyPath'),
        icon: Clipboard,
        onSelect: () => copyPaths(target.map((e) => e.path))
      },
      {
        label:
          target.length > 1 ? t('menu.deleteMany', { number: target.length }) : t('common.delete'),
        icon: Trash2,
        shortcut: 'Del',
        danger: true,
        onSelect: () => void askDelete(target)
      },
      'sep',
      {
        label: t('menu.properties'),
        icon: Info,
        shortcut: 'Alt+Enter',
        disabled: !one,
        onSelect: () => one && setProps(one)
      }
    ]
  }
  const backgroundMenu = (): MenuItem[] => [
    {
      label: t('explorer.newFolder'),
      icon: FolderPlus,
      shortcut: 'Ctrl+Shift+N',
      onSelect: () => void newFolder()
    },
    { label: t('toolbar.refresh'), icon: RefreshCw, shortcut: 'F5', onSelect: reload },
    {
      label: t('menu.selectAll'),
      icon: Check,
      shortcut: 'Ctrl+A',
      onSelect: () => patch(selectAll(selection, paths))
    },
    'sep',
    {
      label: shelfCount ? t('menu.dropShelfHere', { count: shelfCount }) : t('menu.shelfEmpty'),
      icon: PackageCheck,
      shortcut: 'Ctrl+Enter',
      disabled: !shelfCount,
      onSelect: () => void dropShelf(loc)
    },
    {
      label: t('menu.copyCurrentPath'),
      icon: Clipboard,
      onSelect: () => copyPaths([loc.path])
    }
  ]
  const openMenuAtCursor = (cur: ExplorerEntry | null): void => {
    // 다른 패널의 같은 경로가 아니라 이 패널의 항목에서 연다(P9).
    const el = cur && scrollRef.current?.querySelector(`[data-path="${CSS.escape(cur.path)}"]`)
    const r = (el ?? scrollRef.current)?.getBoundingClientRect()
    if (!r) return
    setMenu({
      x: r.left + 24,
      y: r.top + Math.min(r.height, 40),
      target: targetOf(),
      keyboard: true
    })
  }

  // ---------- 키보드 ----------
  const typeAhead = useTypeAhead(
    () => items.map((e) => e.name),
    (name) =>
      moveTo(
        items.findIndex((e) => e.name === name),
        { shift: false, ctrl: false }
      )
  )
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (isTyping(e.target)) return
    const fi = tab.focus ? (indexOf.get(tab.focus) ?? -1) : -1
    const cur = fi >= 0 ? items[fi] : null
    const ctrl = e.ctrlKey || e.metaKey
    const handled = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (e.altKey) {
      const run = {
        ArrowUp: () => useTabsStore.getState().goUp(tab.id),
        ArrowLeft: () => useTabsStore.getState().goBack(tab.id),
        ArrowRight: () => useTabsStore.getState().goForward(tab.id),
        Enter: () => cur && setProps(cur)
      }[e.key]
      if (run) {
        handled()
        run()
      }
      return
    }
    const listKeys = grid ? e.key : e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? '' : e.key
    const pageRows = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / rowH) - 1)
    const target = navIndex(listKeys, fi, items.length, cols, pageRows)
    if (target !== null) {
      handled()
      moveTo(target, { shift: e.shiftKey, ctrl })
      return
    }
    switch (e.key) {
      case 'Enter':
        handled()
        if (ctrl) void dropShelf(loc)
        else if (cur) open(cur)
        return
      case ' ':
        handled()
        if (ctrl && cur) patch(toggleSelect(selection, cur.path))
        else if (cur?.type === 'directory') setProps(cur)
        else if (cur) open(cur)
        return
      case 'Backspace':
        handled()
        useTabsStore.getState().goUp(tab.id)
        return
      case 'F2':
        handled()
        if (cur && interactive) setRenaming({ key, path: cur.path })
        return
      case 'Delete':
        handled()
        if (interactive) void askDelete(targetOf())
        return
      case 'F5':
        handled()
        reload()
        return
      case 'Escape':
        if (tab.sel.length) {
          handled()
          patch(clearSelection())
        } else if (tab.query) {
          handled()
          patch({ query: '' })
        }
        return
      case 'ContextMenu':
        handled()
        openMenuAtCursor(cur)
        return
      case 'F10':
        if (!e.shiftKey) return
        handled()
        openMenuAtCursor(cur)
        return
    }
    if (ctrl) {
      const zoom = (d: number) => (): void => useSettingsStore.getState().adjustTileSize(d)
      const run: Record<string, (() => void) | undefined> = {
        a: () => patch(selectAll(selection, paths)),
        r: reload,
        l: () => setEditingPath(true),
        f: () => setSearchOpen(true),
        n: e.shiftKey ? () => void newFolder() : undefined,
        '=': zoom(ZOOM_STEP),
        '+': zoom(ZOOM_STEP),
        '-': zoom(-ZOOM_STEP)
      }
      const action = run[e.key.toLowerCase()]
      if (action) {
        handled()
        action()
      }
      return
    }
    // Shift+S만 선반 담기다(D29). 그 밖의 글자는 입력해서 고르기(한글 초성 포함). Space·\는 넣지 않는다.
    if (e.shiftKey && e.key === 'S') {
      handled()
      shelve(targetOf())
      return
    }
    if (e.key === '\\') return
    if (typeAhead(e)) e.stopPropagation()
  }

  // ---------- 끌어 놓기 ----------
  const paneDrop = useDropTarget(`pane:${tab.id}`, interactive ? loc : null)

  const itemProps = (entry: ExplorerEntry): ItemProps => ({
    entry,
    tabId: tab.id,
    scope,
    selected: selSet.has(entry.path),
    shelved: shelved.has(locKey(entry)),
    renaming: renameHere && renaming?.path === entry.path,
    nameTaken: (name) => {
      const next = name.trim()
      return name !== entry.name && next !== entry.name && folderNames.has(next)
    },
    onSelect: (e, it) => patch(clickSelect(selection, paths, it.path, e, currentPlatform())),
    onToggle: (it) => patch(toggleSelect(selection, it.path)),
    onOpen: open,
    onOpenTab: (it) => useTabsStore.getState().openTab(locOf(it), false),
    onContext: (e, it) => {
      if (shouldDeferToNativeContextMenu(e, window.api?.debugToolsEnabled ?? false)) return
      e.preventDefault()
      // 전파를 막는다: 문서까지 가면 이미 열린 이 패널의 메뉴가 그것을 바깥 우클릭으로 보고 새로 연
      // 메뉴를 닫는다. 다른 패널·탭줄의 메뉴는 새 메뉴가 열릴 때 닫힌다(ItemMenu, split-view §4 18행).
      e.stopPropagation()
      const inSelection = selSet.has(it.path)
      if (!inSelection) selectOnly(it.path)
      setMenu({ x: e.clientX, y: e.clientY, target: inSelection ? selected : [it] })
    },
    onDragStart: (e, it) => {
      if (selSet.has(it.path)) startDrag(e, selected)
      else {
        selectOnly(it.path)
        startDrag(e, [it])
      }
    },
    onRename: (it, name) => void commitRename(it, name)
  })

  const showList = (mode === 'live' || mode === 'pending' || mode === 'stale') && items.length > 0
  const reconnect = (): void => {
    if (loc.server) connectToServer(loc.server)
  }

  // 패널 안 pointerdown·포커스 → 그 패널이 활성(P7). capture라 같은 이벤트의 목록 처리보다 먼저다(함정 3).
  const activateHere = (): void => {
    if (useTabsStore.getState().activeId !== tab.id) useTabsStore.getState().activate(tab.id)
  }

  return (
    <section
      ref={paneRef}
      role="region"
      aria-label={
        split
          ? t(paneId === 'left' ? 'split.paneLeft' : 'split.paneRight', { name: sourceLabel(loc) })
          : t(remote ? 'explorer.remote' : 'explorer.local')
      }
      data-pane={paneId}
      data-tab-pane={tab.id}
      data-active={active ? '' : undefined}
      data-entering={entering}
      onPointerDownCapture={activateHere}
      onFocusCapture={activateHere}
      onAnimationEnd={(e) => e.target === e.currentTarget && onSettled()}
      style={
        basis === null
          ? undefined
          : { order: paneId === 'left' ? 0 : 2, flexGrow: 0, flexShrink: 1, flexBasis: `${basis}%` }
      }
      className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf)]"
    >
      {split && active && (
        <div
          data-testid="pane-active-bar"
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 z-30 h-0.5 bg-[var(--ac)]"
        />
      )}
      <PathBar
        tab={tab}
        dim={split && !active}
        editing={editingPath}
        onEditingChange={(v) => {
          setEditingPath(v)
          if (!v) refocus()
        }}
        searchOpen={searchOpen}
        onSearchOpenChange={setSearchOpen}
        entries={listable}
        filterHidden={filtered.filterCount}
        canWrite={mode === 'live'}
        onNewFolder={() => void newFolder()}
        onReload={reload}
      />
      {busyLevel > 0 && (
        <div
          data-testid="explorer-busy"
          className="absolute inset-x-0 top-[var(--path-bar-h,52px)] z-10 h-0.5 overflow-hidden bg-[var(--acw)]"
        >
          <div className="indet h-full w-1/3 bg-[var(--ac)]" />
        </div>
      )}
      {mode === 'stale' && <StaleBanner onReconnect={reconnect} />}
      {!grid && showList && <ListHeader tab={tab} />}
      <div
        ref={scrollRef}
        id={`explorer-list-${tab.id}`}
        tabIndex={0}
        {...(showList
          ? {
              role: 'listbox',
              'aria-multiselectable': true,
              'aria-label': t('explorer.items', { location: locLabel(loc) }),
              'aria-activedescendant': focusPath ? optId(focusPath, scope) : undefined
            }
          : { 'aria-label': t('explorer.items', { location: locLabel(loc) }) })}
        aria-busy={busy}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          lastTop.current = e.currentTarget.scrollTop
        }}
        onMouseUp={(e) => {
          if (e.button === 3) useTabsStore.getState().goBack(tab.id)
          if (e.button === 4) useTabsStore.getState().goForward(tab.id)
        }}
        onContextMenu={(e) => {
          if ((e.target as Element).closest('[data-path]')) return
          if (shouldDeferToNativeContextMenu(e, window.api?.debugToolsEnabled ?? false)) return
          e.preventDefault()
          // 항목 메뉴와 같은 까닭으로 전파를 막는다(빈 곳을 다시 우클릭하면 메뉴가 그 자리로 옮겨 간다).
          e.stopPropagation()
          if (interactive) setMenu({ x: e.clientX, y: e.clientY, target: [] })
        }}
        onDragOver={paneDrop.handlers.onDragOver}
        onDrop={paneDrop.handlers.onDrop}
        className={cn(
          'scroll relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]',
          showList ? 'focus-visible:outline-none' : 'focus-visible:outline-offset-[-3px]'
        )}
      >
        {showList && (
          // h-full: 안쪽 그리드·리스트의 minHeight 100%가 풀려 마지막 항목 아래 빈 곳에서도 마퀴가 시작된다
          <div
            className={cn(
              'h-full transition-opacity',
              dimmed && 'opacity-60',
              mode === 'stale' && 'grayscale-[.4]',
              mode === 'pending' && 'pointer-events-none'
            )}
          >
            {grid ? (
              <FileGrid
                items={items}
                scrollRef={scrollRef}
                layout={layout}
                server={remote && gate === 'live' ? loc.server : undefined}
                itemProps={itemProps}
                setSelection={(sel) => patch(selectMany(selection, sel))}
                getSelection={() =>
                  new Set(useTabsStore.getState().tabs.find((x) => x.id === tab.id)?.sel)
                }
              />
            ) : (
              <FileList
                items={items}
                scrollRef={scrollRef}
                itemProps={itemProps}
                setSelection={(sel) => patch(selectMany(selection, sel))}
                getSelection={() =>
                  new Set(useTabsStore.getState().tabs.find((x) => x.id === tab.id)?.sel)
                }
              />
            )}
          </div>
        )}
        {mode === 'skeleton' && (
          <Skeleton
            grid={grid}
            cols={layout.cols}
            cellWidth={layout.cellWidth}
            imageHeight={layout.imageHeight}
          />
        )}
        {mode === 'error' && (
          <ListErrorPanel
            code={listing?.code}
            error={listing?.error}
            onRetry={reload}
            onUp={() => useTabsStore.getState().goUp(tab.id)}
            onReconnect={reconnect}
          />
        )}
        {(gate === 'offline' || gate === 'connecting') &&
          (loc.server ? (
            <ServerOfflinePanel
              server={loc.server}
              connecting={gate === 'connecting'}
              onConnect={reconnect}
            />
          ) : (
            <OfflinePanel connecting={gate === 'connecting'} />
          ))}
        {gate === 'lost' && <LostPanel onReconnect={reconnect} />}
        {(mode === 'live' || mode === 'stale') && items.length === 0 && (
          <EmptyPanel
            query={tab.query}
            queryCount={filtered.queryCount}
            filterCount={filtered.filterCount}
            filterText={filterText}
            shelfCount={shelfCount}
            canWrite={mode === 'live'}
            onClearQuery={() => patch({ query: '' })}
            onClearFilter={() => patch({ filter: EMPTY_FILTER })}
            onNewFolder={() => void newFolder()}
            onDropShelf={() => void dropShelf(loc)}
          />
        )}
      </div>
      {busyLevel === 2 && listing?.status === 'loading' && (
        <div className="pointer-events-none absolute left-1/2 top-16 z-10 -translate-x-1/2">
          <span
            role="status"
            className="fade flex items-center gap-2 rounded-full border border-[var(--bd)] bg-[var(--sf)] px-3 py-1.5 text-[12px] text-[var(--mu)] shadow-sm"
          >
            <Loader className="spin h-3.5 w-3.5" aria-hidden />
            {t('explorer.listing', { count: base.length })}
          </span>
        </div>
      )}
      {paneDrop.over && (
        <>
          <div
            className={cn(
              'pointer-events-none absolute inset-x-2 bottom-2 top-[calc(var(--path-bar-h,52px)+4px)] z-20 rounded-xl border-2',
              paneDrop.valid ? 'border-[var(--ac)]' : 'border-dashed border-[var(--dg)]'
            )}
          />
          {dragging && (
            <div className="pointer-events-none absolute bottom-20 left-1/2 z-20 -translate-x-1/2">
              <span
                className={cn(
                  'pop flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-semibold shadow-lg',
                  paneDrop.valid ? 'bg-[var(--ac)] text-[var(--acx)]' : 'bg-[var(--dg)] text-white'
                )}
              >
                {paneDrop.valid
                  ? t('send.toLocation', { verb: paneDrop.verb, location: locLabel(loc) })
                  : paneDrop.reason}
              </span>
            </div>
          )}
        </>
      )}
      {menu && (
        <ItemMenu
          x={menu.x}
          y={menu.y}
          label={
            menu.target.length === 1
              ? menu.target[0].name
              : menu.target.length
                ? t('rail.selected', { count: menu.target.length })
                : locLabel(loc)
          }
          items={menu.target.length ? itemMenu(menu.target) : backgroundMenu()}
          focusFirst={menu.keyboard}
          onClose={(reason) => {
            setMenu(null)
            // 다른 메뉴가 열려 닫혔으면 포커스는 그 메뉴 것이다. 되돌리면 이 패널이 다시 활성이 된다(P7).
            if (reason !== 'replaced') refocus()
          }}
        />
      )}
      {props && (
        <PropertiesDialog
          entry={props}
          onClose={() => {
            setProps(null)
            refocus()
          }}
        />
      )}
      {lightbox !== null && files[lightbox] && (
        <Lightbox
          items={files}
          index={lightbox}
          onIndex={(i) => {
            setLightbox(i)
            selectOnly(files[i].path)
            ensureVisible(indexOf.get(files[i].path) ?? -1)
          }}
          onClose={() => {
            setLightbox(null)
            refocus()
          }}
        />
      )}
    </section>
  )
}
