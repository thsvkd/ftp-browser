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
import { flyTo, sourcesFor } from '@renderer/lib/flyTo'
import { gridLayout } from '@renderer/lib/gridGeometry'
import { currentPlatform } from '@renderer/lib/platform'
import {
  clickSelect,
  moveFocus,
  navIndex,
  toggleSelect,
  type SelectionState
} from '@renderer/lib/selectionModel'
import { planSend } from '@renderer/lib/sendPlan'
import {
  connectToServer,
  dropShelf,
  loadPlaces,
  locLabel,
  sendDestinations,
  sendItems,
  sourceLabel,
  useConnection
} from '@renderer/lib/sendItems'
import { cn } from '@renderer/lib/utils'
import { confirmDelete } from '@renderer/stores/useConfirmStore'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useGalleryStore } from '@renderer/stores/useGalleryStore'
import { useListingStore } from '@renderer/stores/useListingStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useActiveTab, useTabsStore, type Tab } from '@renderer/stores/useTabsStore'
import { isSafeLocalName, isSafeRemoteName, uniqueLocalNames } from '@shared/entryName'
import type { FtpConnectionState } from '@shared/types/ftp'
import type { IpcResult } from '@shared/types/ipc'
import { startDrag, useDnd, useDropTarget } from './dnd'
import { DragGhost } from './DragGhost'
import {
  EmptyPanel,
  ListErrorPanel,
  LostPanel,
  OfflinePanel,
  OtherServerPanel,
  Skeleton,
  StaleBanner
} from './ExplorerStates'
import { FileGrid, ZOOM_STEP } from './FileGrid'
import { FileList } from './FileList'
import { ItemMenu, type MenuItem } from './ItemMenu'
import { Lightbox } from './Lightbox'
import { ListHeader } from './ListHeader'
import { PathBar } from './PathBar'
import { PropertiesDialog } from './PropertiesDialog'
import type { ItemProps } from './useItem'

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

const NONE: ExplorerEntry[] = []

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * 원격 탭의 처지(D2): 지금 연결된 서버의 탭이면 목록을 읽는다(live). 다른 서버면 연결 버튼(other),
 * 연결이 끊겼으면 지난 목록(stale)이나 끊김 패널(lost), 연결이 없으면 연결 안 됨 패널(offline).
 */
type Gate = 'live' | 'other' | 'stale' | 'lost' | 'offline'

/**
 * 활성 탭의 탐색 영역. 탭이 바뀌면 다시 마운트되어(탭 id가 key) 메뉴·이름 바꾸기 같은
 * 지역 상태가 다른 탭으로 새지 않는다. 시작 직후 탭이 없으면 아무것도 그리지 않는다.
 */
export function Explorer(): React.JSX.Element | null {
  const tab = useActiveTab()
  return tab ? <TabExplorer key={tab.id} tab={tab} /> : null
}

function TabExplorer({ tab }: { tab: Tab }): React.JSX.Element {
  const t = useT()
  const { loc } = tab
  const key = locKey(loc)
  const remote = loc.side === 'remote'
  const listing = useListingStore((s) => s.byKey[key])
  const status = useFtpStore((s) => s.connectionStatus)
  const conn = useConnection()
  const showHidden = useSettingsStore((s) => s.showHidden)
  const tileSize = useSettingsStore((s) => s.tileSize)
  const shelfKeys = useShelfStore((s) => s.items.map((i) => locKey(i.entry)).join('\n'))
  const shelfCount = useShelfStore((s) => s.items.length)
  const dragging = useDnd((s) => s.items !== null)
  const patch = (p: Partial<Tab>): void => useTabsStore.getState().patchTab(tab.id, p)

  const cached = !!listing && (listing.status === 'ready' || listing.entries.length > 0)
  const gate: Gate = !remote
    ? 'live'
    : status === 'connected'
      ? !loc.server || loc.server === conn.server
        ? 'live'
        : 'other'
      : status === 'error'
        ? cached
          ? 'stale'
          : 'lost'
        : 'offline'

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

  const filtered = useMemo(() => {
    const f = filterEntries(base, { query: tab.query, photosOnly: tab.photosOnly, showHidden })
    return { ...f, visible: sortEntries(f.visible, tab.sort) }
  }, [base, tab.query, tab.photosOnly, showHidden, tab.sort])
  const items = filtered.visible
  const paths = useMemo(() => items.map((e) => e.path), [items])
  const indexOf = useMemo(() => new Map(paths.map((p, i) => [p, i])), [paths])
  const files = useMemo(() => items.filter((e) => e.type === 'file'), [items])
  const selSet = useMemo(() => new Set(tab.sel), [tab.sel])
  const selected = useMemo(() => items.filter((e) => selSet.has(e.path)), [items, selSet])
  const shelved = useMemo(() => new Set(shelfKeys.split('\n')), [shelfKeys])
  const cursor = tab.focus && indexOf.has(tab.focus) ? tab.focus : (items[0]?.path ?? null)

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
  useLayoutEffect(() => {
    if (!remoteKey) return
    window.api.invoke('thumbnail:cancelAll')
    window.api.invoke('gallery:cancelAll')
    useGalleryStore.getState().clearRemote()
  }, [remoteKey])

  // 원격 연결 상태(main이 알린다). 옛 원격 패널에 있던 구독이다.
  useEffect(
    () =>
      window.api.on('ftp:connectionStatus', (...args: unknown[]) =>
        useFtpStore.getState().setConnectionState(args[0] as FtpConnectionState)
      ),
    []
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

  // 다른 것이 포커스를 갖고 있지 않으면 목록이 받는다(탭 전환 뒤, 함정 13).
  useEffect(() => {
    if (document.activeElement === document.body) scrollRef.current?.focus({ preventScroll: true })
  }, [])

  // ---------- 로딩 표시: 150ms 뒤 2px 막대, 1초 뒤 "Listing…" ----------
  const busy =
    (gate === 'live' && (listing?.status === 'loading' || !!listing?.refreshing)) ||
    (remote && status === 'connecting')
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
  const [menu, setMenu] = useState<{ x: number; y: number; target: ExplorerEntry[] } | null>(null)
  const [props, setProps] = useState<ExplorerEntry | null>(null)
  const [lightbox, setLightbox] = useState<number | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [editingPath, setEditingPath] = useState(false)
  const [listFocused, setListFocused] = useState(false)
  const refocus = (): void => scrollRef.current?.focus({ preventScroll: true })

  // ---------- 선택 ----------
  const selection: SelectionState = { sel: tab.sel, anchor: tab.anchor, focus: tab.focus }
  const selectOnly = (path: string): void => patch({ sel: [path], anchor: path, focus: path })
  const moveTo = (i: number, mods: { shift: boolean; ctrl: boolean }): void => {
    if (i < 0 || i >= items.length) return
    patch(moveFocus(selection, paths, i, mods))
    ensureVisible(i)
  }
  const targetOf = (cur: ExplorerEntry | null): ExplorerEntry[] =>
    selected.length ? selected : cur ? [cur] : []

  // ---------- 동작 ----------
  const locOf = (e: ExplorerEntry): Loc => ({
    side: e.side,
    path: e.path,
    ...(e.server ? { server: e.server } : {})
  })
  const open = (e: ExplorerEntry): void => {
    if (e.type === 'directory') useTabsStore.getState().navigate(locOf(e))
    else {
      const i = files.indexOf(e)
      if (i >= 0) setLightbox(i)
    }
  }
  const shelve = (entries: ExplorerEntry[]): void => {
    if (!entries.length) return
    const from = sourcesFor(entries.map((e) => e.path))
    if (!useShelfStore.getState().add(entries)) {
      toast(t('toast.alreadyOnShelf'))
      return
    }
    flyTo(from, document.querySelector('[data-shelf-target]'))
  }
  const unshelve = (entries: ExplorerEntry[]): void =>
    useShelfStore.getState().remove(entries.map(locKey))

  const askDelete = async (entries: ExplorerEntry[]): Promise<void> => {
    if (!entries.length || !(await confirmDelete(entries))) return
    // 확인을 기다리는 동안 다른 폴더로 옮겨도 고른 시점의 경로를 지운다.
    const targets = entries.map((e) => ({ path: e.path, isDirectory: e.type === 'directory' }))
    try {
      const r = await window.api.invoke<IpcResult<void>>(
        remote ? 'ftp:deleteBatch' : 'local:deleteBatch',
        targets
      )
      if (!r.success) toast.error(t('toast.deleteFailed'), { description: r.error })
    } catch (err) {
      toast.error(t('toast.deleteFailed'), { description: errorText(err) })
    } finally {
      unshelve(entries)
      patch({ sel: [], anchor: null })
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
    const next = name?.trim()
    if (!next || next === entry.name || !validName(next)) return
    const target = joinPath(entry.side, parentPath(entry.side, entry.path) ?? loc.path, next)
    try {
      const r = await window.api.invoke<IpcResult<void>>(
        remote ? 'ftp:rename' : 'local:rename',
        entry.path,
        target
      )
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
      const r = await window.api.invoke<IpcResult<void>>(remote ? 'ftp:mkdir' : 'local:mkdir', path)
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
    setRenaming(path)
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
          const plan = planSend(target, dest, conn)
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
        disabled: !one,
        onSelect: () => one && setRenaming(one.path)
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
      onSelect: () => patch({ sel: paths })
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
    const el = cur && document.querySelector(`[data-path="${CSS.escape(cur.path)}"]`)
    const r = (el ?? scrollRef.current)?.getBoundingClientRect()
    if (!r) return
    setMenu({ x: r.left + 24, y: r.top + Math.min(r.height, 40), target: targetOf(cur) })
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
        ArrowUp: () => useTabsStore.getState().goUp(),
        ArrowLeft: () => useTabsStore.getState().goBack(),
        ArrowRight: () => useTabsStore.getState().goForward(),
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
        useTabsStore.getState().goUp()
        return
      case 'F2':
        handled()
        if (cur && interactive) setRenaming(cur.path)
        return
      case 'Delete':
        handled()
        if (interactive) void askDelete(targetOf(cur))
        return
      case 'F5':
        handled()
        reload()
        return
      case 'Escape':
        if (tab.sel.length) {
          handled()
          patch({ sel: [], anchor: null })
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
        a: () => patch({ sel: paths }),
        r: reload,
        l: () => setEditingPath(true),
        f: () => {
          // 좁은 경로 막대에서는 돋보기 버튼이다: 누르면 칸이 열리며 포커스를 받는다.
          const find = document.getElementById(`explorer-filter-${tab.id}`)
          if (find instanceof HTMLButtonElement) find.click()
          else find?.focus()
        },
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
      shelve(targetOf(cur))
      return
    }
    if (e.key === '\\') return
    if (typeAhead(e)) e.stopPropagation()
  }

  // ---------- 끌어 놓기 ----------
  const paneDrop = useDropTarget(`pane:${tab.id}`, interactive ? loc : null)

  const itemProps = (entry: ExplorerEntry): ItemProps => ({
    entry,
    selected: selSet.has(entry.path),
    cursor: cursor === entry.path,
    listFocused,
    shelved: shelved.has(locKey(entry)),
    renaming: renaming === entry.path,
    onSelect: (e, it) => patch(clickSelect(selection, paths, it.path, e, currentPlatform())),
    onToggle: (it) => patch(toggleSelect(selection, it.path)),
    onOpen: open,
    onOpenTab: (it) => useTabsStore.getState().openTab(locOf(it), false),
    onContext: (e, it) => {
      if (shouldDeferToNativeContextMenu(e, window.api?.debugToolsEnabled ?? false)) return
      e.preventDefault()
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

  return (
    <section
      role="region"
      aria-label={t(remote ? 'explorer.remote' : 'explorer.local')}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf)]"
    >
      <PathBar
        tab={tab}
        editing={editingPath}
        onEditingChange={(v) => {
          setEditingPath(v)
          if (!v) refocus()
        }}
        photosHidden={filtered.photosCount}
        canWrite={mode === 'live'}
        onNewFolder={() => void newFolder()}
        onReload={reload}
      />
      {busyLevel > 0 && (
        <div
          data-testid="explorer-busy"
          className="absolute inset-x-0 top-[52px] z-10 h-0.5 overflow-hidden bg-[var(--acw)]"
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
              'aria-activedescendant': cursor ? optId(cursor) : undefined
            }
          : { 'aria-label': t('explorer.items', { location: locLabel(loc) }) })}
        aria-busy={busy}
        onKeyDown={onKeyDown}
        onFocus={() => setListFocused(true)}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setListFocused(false)}
        onScroll={(e) => {
          lastTop.current = e.currentTarget.scrollTop
        }}
        onMouseUp={(e) => {
          if (e.button === 3) useTabsStore.getState().goBack()
          if (e.button === 4) useTabsStore.getState().goForward()
        }}
        onContextMenu={(e) => {
          if ((e.target as Element).closest('[data-path]')) return
          if (shouldDeferToNativeContextMenu(e, window.api?.debugToolsEnabled ?? false)) return
          e.preventDefault()
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
          <div
            className={cn(
              'transition-opacity',
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
                remote={remote && gate === 'live'}
                itemProps={itemProps}
                setSelection={(sel) => patch({ sel, focus: sel.at(-1) ?? tab.focus })}
                getSelection={() =>
                  new Set(useTabsStore.getState().tabs.find((x) => x.id === tab.id)?.sel)
                }
              />
            ) : (
              <FileList
                items={items}
                scrollRef={scrollRef}
                itemProps={itemProps}
                setSelection={(sel) => patch({ sel, focus: sel.at(-1) ?? tab.focus })}
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
            onUp={() => useTabsStore.getState().goUp()}
            onReconnect={reconnect}
          />
        )}
        {gate === 'other' && loc.server && (
          <OtherServerPanel server={loc.server} onConnect={reconnect} />
        )}
        {gate === 'offline' && <OfflinePanel connecting={status === 'connecting'} />}
        {gate === 'lost' && <LostPanel onReconnect={reconnect} />}
        {(mode === 'live' || mode === 'stale') && items.length === 0 && (
          <EmptyPanel
            query={tab.query}
            queryCount={filtered.queryCount}
            photosCount={filtered.photosCount}
            shelfCount={shelfCount}
            canWrite={mode === 'live'}
            onClearQuery={() => patch({ query: '' })}
            onShowAll={() => patch({ photosOnly: false })}
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
              'pointer-events-none absolute inset-x-2 bottom-2 top-[56px] z-20 rounded-xl border-2',
              paneDrop.valid ? 'border-[var(--ac)]' : 'border-dashed border-[var(--dg)]'
            )}
          />
          {dragging && (
            <div className="pointer-events-none absolute bottom-6 left-1/2 z-20 -translate-x-1/2">
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
          onClose={() => {
            setMenu(null)
            refocus()
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
      <DragGhost />
    </section>
  )
}
