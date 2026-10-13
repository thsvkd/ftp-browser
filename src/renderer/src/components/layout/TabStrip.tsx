import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeftRight,
  Columns2,
  Copy,
  Laptop,
  PanelRightClose,
  Plus,
  Server,
  X
} from 'lucide-react'
import { useT } from '@renderer/i18n'
import type { Loc } from '@renderer/lib/explorerEntry'
import { SPRING_MS } from '@renderer/lib/explorerLayout'
import { connectedKeys } from '@renderer/lib/connections'
import { loadPlaces, locLabel, sourceLabel } from '@renderer/lib/sendItems'
import { cn } from '@renderer/lib/utils'
import { useTabsStore, type Tab } from '@renderer/stores/useTabsStore'
import { SourceBadge } from '@renderer/components/common/SourceBadge'
import { useDropTarget } from '@renderer/components/explorer/dnd'
import { ItemMenu, type MenuItem } from '@renderer/components/explorer/ItemMenu'
import { placeAndFocus, useTabDrag, useTabDragStore } from './useTabDrag'

/** 탭 버튼이 탭줄에 알리는 것: 드래그 시작(P16)·드래그 뒤 click 무시·탭 메뉴 열기(P6) */
interface PillHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLElement>, id: string) => void
  consumeClick: () => boolean
  onMenu: (id: string, x: number, y: number) => void
}

function TabPill({
  tab,
  active,
  closable,
  unit,
  handlers
}: {
  tab: Tab
  active: boolean
  closable: boolean
  /** 순서 변경의 단위(일반 탭). 묶음 알약의 반쪽은 묶음이 단위다 */
  unit: boolean
  handlers: PillHandlers
}): React.JSX.Element {
  const t = useT()
  const { activate, closeTab } = useTabsStore.getState()
  // 끌고 와서 머무르면 그 탭이 열린다. 놓으면 그 탭의 위치로 보낸다.
  const drop = useDropTarget(`tab:${tab.id}`, tab.loc, {
    spring: () => activate(tab.id),
    springMs: active ? 0 : SPRING_MS
  })
  const label = locLabel(tab.loc)
  return (
    <div
      data-tab-unit={unit ? tab.id : undefined}
      onDragOver={drop.handlers.onDragOver}
      onDrop={drop.handlers.onDrop}
      className={cn(
        'group relative flex h-9 max-w-[240px] shrink-0 items-center rounded-full border transition-colors',
        active
          ? 'border-[var(--bd)] bg-[var(--sf)] shadow-[0_1px_2px_rgba(0,0,0,.06)]'
          : 'border-transparent hover:bg-[var(--hv)]',
        drop.over && (drop.valid ? 'border-[var(--ac)] bg-[var(--acw)]' : 'border-[var(--dg)]')
      )}
    >
      <button
        role="tab"
        data-tab={tab.id}
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        onPointerDown={(e) => handlers.onPointerDown(e, tab.id)}
        onClick={() => {
          if (!handlers.consumeClick()) activate(tab.id)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          // 문서까지 가면 이미 열린 탭 메뉴가 바깥 우클릭으로 보고 새로 연 메뉴를 닫는다(ItemMenu).
          e.stopPropagation()
          handlers.onMenu(tab.id, e.clientX, e.clientY)
        }}
        onAuxClick={(e) => e.button === 1 && closable && closeTab(tab.id)}
        title={
          drop.over
            ? drop.valid
              ? `${drop.verb} → ${label}`
              : (drop.reason ?? '')
            : `${sourceLabel(tab.loc)} · ${tab.loc.path}`
        }
        className={cn(
          'flex h-full min-w-0 items-center gap-2 rounded-full pl-1.5 text-[13px]',
          closable ? 'pr-1' : 'pr-3.5',
          active ? 'font-semibold text-[var(--tx)]' : 'text-[var(--mu)]'
        )}
      >
        <SourceBadge side={tab.loc.side} size={24} />
        <span className="truncate">{label}</span>
        {drop.over && drop.valid && (
          <span className="shrink-0 rounded-full bg-[var(--ac)] px-2 py-0.5 text-[11px] font-semibold text-[var(--acx)]">
            {drop.verb}
          </span>
        )}
      </button>
      {closable && (
        <button
          tabIndex={-1}
          onClick={() => closeTab(tab.id)}
          aria-label={t('tabs.close', { name: label })}
          title={t('tabs.closeTooltip')}
          className={cn(
            'mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]',
            !active && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
          )}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
      {drop.over && !active && (
        <span className="pointer-events-none absolute inset-x-4 bottom-[3px] h-[3px] overflow-hidden rounded-full bg-[var(--acw)]">
          <span className="spring-fill block h-full bg-[var(--ac)]" />
        </span>
      )}
    </div>
  )
}

/** 끄는 탭의 고스트와 순서 변경 표시선(split-view §5). `document.body`에 그려 포인터를 따른다. */
function TabDragLayer(): React.JSX.Element | null {
  const id = useTabDragStore((s) => s.id)
  const x = useTabDragStore((s) => s.x)
  const y = useTabDragStore((s) => s.y)
  const mode = useTabDragStore((s) => s.mode)
  const insert = useTabDragStore((s) => s.insert)
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === id))
  if (!tab) return null
  return createPortal(
    <>
      <div
        data-testid="tab-drag-ghost"
        aria-hidden
        className="pointer-events-none fixed z-[70] flex h-9 max-w-[240px] items-center gap-2 rounded-full border border-[var(--bd)] bg-[var(--sf)] pl-1.5 pr-3.5 text-[13px] font-semibold text-[var(--tx)] opacity-90 shadow-[var(--shadow)]"
        style={{ left: x - 20, top: y - 18 }}
      >
        <SourceBadge side={tab.loc.side} size={24} />
        <span className="truncate">{locLabel(tab.loc)}</span>
      </div>
      {mode === 'reorder' && insert && (
        <div
          data-testid="tab-drop-indicator"
          data-index={insert.index}
          aria-hidden
          className="pointer-events-none fixed z-[70] w-[2px] rounded-full bg-[var(--ac)]"
          style={{ left: insert.x, top: insert.top, height: insert.height }}
        />
      )}
    </>,
    document.body
  )
}

/**
 * 알약 탭: 어느 쪽의 어느 폴더든 담는다. Ctrl+T(지금 위치로 새 탭)·Ctrl+W·Ctrl+Tab은 창 어디서나,
 * ←→·Home/End·Delete는 탭 줄 안에서. 분할 짝은 묶음 알약 `[A | B]` 하나로 그린다(F1). 탭을 끌면
 * 순서 변경·분할(`useTabDrag`), 우클릭·Shift+F10·메뉴 키로 탭 메뉴(P6).
 */
export function TabStrip(): React.JSX.Element {
  const t = useT()
  const tabs = useTabsStore((s) => s.tabs)
  const activeId = useTabsStore((s) => s.activeId)
  const split = useTabsStore((s) => s.split)
  const stripRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    label: string
    items: MenuItem[]
  } | null>(null)
  const drag = useTabDrag(stripRef)
  // 메뉴를 열 때 포커스가 있던 곳. 메뉴가 닫히며 포커스를 잃으면 그리로 돌아간다(키보드로 연 탭 메뉴, P6).
  const opener = useRef<HTMLElement | null>(null)
  const remember = (): void => {
    const el = document.activeElement
    // 열린 메뉴 안에서 다른 메뉴로 옮겨 가면 처음 연 곳을 그대로 둔다.
    if (el?.closest('[role="menu"]')) return
    opener.current = el instanceof HTMLElement && el !== document.body ? el : null
  }
  const closeMenu = (reason?: 'replaced'): void => {
    setMenu(null)
    const now = document.activeElement
    // 다른 메뉴가 열렸거나, 사용자가 이미 다른 곳에 포커스를 두었으면 건드리지 않는다.
    if (reason === 'replaced' || (now && now !== document.body && !now.closest('[role="menu"]')))
      return
    const back = opener.current?.isConnected
      ? opener.current
      : listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    back?.focus()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return
      const s = useTabsStore.getState()
      const active = s.tabs.find((x) => x.id === s.activeId)
      if (!active) return
      const key = e.key.toLowerCase()
      if (key === 'tab') s.cycleTab(e.shiftKey ? -1 : 1)
      else if (key === 't' && !e.shiftKey) s.openTab(active.loc)
      else if (key === 'w' && !e.shiftKey) s.closeTab(active.id)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const focusTab = (i: number): void => {
    const btns = listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')
    btns?.[(i + tabs.length) % tabs.length]?.focus()
  }

  const openMenu = async (x: number, y: number): Promise<void> => {
    remember()
    const { openTab } = useTabsStore.getState()
    const home = (await loadPlaces())?.home
    const locs: Loc[] = [
      ...(home ? [{ side: 'local' as const, path: home }] : []),
      // 연결된 서버마다 루트 하나(연결된 순서, MC31). 메뉴를 여는 순간 읽는다
      ...connectedKeys().map((server) => ({ side: 'remote' as const, path: '/', server }))
    ]
    setMenu({
      x,
      y,
      label: t('tabs.new'),
      items: [
        ...locs.map((loc) => ({
          label: `${sourceLabel(loc)} › ${locLabel(loc)}`,
          icon: loc.side === 'remote' ? Server : Laptop,
          onSelect: () => void openTab(loc)
        })),
        ...(locs.length ? ['sep' as const] : []),
        {
          label: t('tabs.duplicate'),
          icon: Copy,
          shortcut: 'Ctrl+T',
          onSelect: () => {
            const s = useTabsStore.getState()
            const active = s.tabs.find((x) => x.id === s.activeId)
            if (active) s.openTab(active.loc)
          }
        }
      ]
    })
  }

  // 탭 메뉴(P6): 일반 탭은 "오른쪽에 분할", 묶음 반쪽은 "분할 해제"·"좌우 바꾸기"
  const openTabMenu = (id: string, x: number, y: number): void => {
    const s = useTabsStore.getState()
    const tab = s.tabs.find((v) => v.id === id)
    if (!tab) return
    remember()
    const half = !!s.split && (id === s.split.leftId || id === s.split.rightId)
    setMenu({
      x,
      y,
      label: locLabel(tab.loc),
      items: half
        ? [
            {
              label: t('split.unsplit'),
              icon: PanelRightClose,
              onSelect: () => useTabsStore.getState().unsplit()
            },
            {
              label: t('split.swap'),
              icon: ArrowLeftRight,
              onSelect: () => useTabsStore.getState().swapPanes()
            }
          ]
        : [
            {
              label: t('split.menuSplitRight'),
              icon: Columns2,
              shortcut: 'Ctrl+\\',
              disabled: s.tabs.length < 2,
              onSelect: () => placeAndFocus(id, 'right')
            }
          ]
    })
  }
  const handlers: PillHandlers = { ...drag, onMenu: openTabMenu }

  // 단위: 일반 탭 하나, 또는 붙어 있는 분할 짝(P4) 하나
  const units: Tab[][] = []
  for (const x of tabs) {
    const prev = units[units.length - 1]
    if (split && x.id === split.rightId && prev?.length === 1 && prev[0].id === split.leftId)
      prev.push(x)
    else units.push([x])
  }
  const pill = (x: Tab, unit: boolean): React.JSX.Element => (
    <TabPill
      key={x.id}
      tab={x}
      active={x.id === activeId}
      closable={tabs.length > 1}
      unit={unit}
      handlers={handlers}
    />
  )

  return (
    <div
      ref={stripRef}
      data-tab-strip
      className="flex h-12 shrink-0 items-center gap-1 border-b border-[var(--bd)] bg-[var(--bg)] px-3"
    >
      <div
        ref={listRef}
        role="tablist"
        aria-label={t('tabs.label')}
        data-region="tabs"
        className="scroll flex min-w-0 items-center gap-1 overflow-x-auto py-1"
        onKeyDown={(e) => {
          const i = tabs.findIndex((x) => x.id === (e.target as HTMLElement).dataset.tab)
          if (i < 0) return
          if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            e.preventDefault()
            const r = (e.target as HTMLElement).getBoundingClientRect()
            openTabMenu(tabs[i].id, r.left, r.bottom + 4)
            return
          }
          if (e.key === 'Delete') {
            e.preventDefault()
            useTabsStore.getState().closeTab(tabs[i].id)
            return
          }
          const to: Record<string, number> = {
            ArrowRight: i + 1,
            ArrowLeft: i - 1,
            Home: 0,
            End: tabs.length - 1
          }
          if (!(e.key in to)) return
          e.preventDefault()
          focusTab(to[e.key])
        }}
      >
        {units.map((u) =>
          u.length === 2 ? (
            <div
              key={u[0].id}
              role="group"
              aria-label={t('split.pair', { left: locLabel(u[0].loc), right: locLabel(u[1].loc) })}
              data-tab-unit={u[0].id}
              className="flex shrink-0 items-center rounded-full border border-[var(--bd)] p-px"
            >
              {pill(u[0], false)}
              <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-[var(--bd)]" />
              {pill(u[1], false)}
            </div>
          ) : (
            pill(u[0], true)
          )
        )}
      </div>
      <button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          void openMenu(r.left, r.bottom + 4)
        }}
        aria-label={t('tabs.new')}
        aria-haspopup="menu"
        title={t('tabs.newTooltip')}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]"
      >
        <Plus className="h-4 w-4" aria-hidden />
      </button>
      {menu && (
        <ItemMenu x={menu.x} y={menu.y} label={menu.label} items={menu.items} onClose={closeMenu} />
      )}
      <TabDragLayer />
    </div>
  )
}
