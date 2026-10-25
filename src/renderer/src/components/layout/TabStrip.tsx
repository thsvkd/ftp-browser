import { useEffect, useRef, useState } from 'react'
import { Copy, Laptop, Plus, Server, X } from 'lucide-react'
import { useT } from '@renderer/i18n'
import type { Loc } from '@renderer/lib/explorerEntry'
import { SPRING_MS } from '@renderer/lib/explorerLayout'
import { loadPlaces, locLabel, sourceLabel, useConnection } from '@renderer/lib/sendItems'
import { cn } from '@renderer/lib/utils'
import { focusedPane, useTabsStore, type Tab } from '@renderer/stores/useTabsStore'
import { SourceBadge } from '@renderer/components/common/SourceBadge'
import { useDropTarget } from '@renderer/components/explorer/dnd'
import { ItemMenu, type MenuItem } from '@renderer/components/explorer/ItemMenu'

function TabPill({
  tab,
  active,
  closable
}: {
  tab: Tab
  active: boolean
  closable: boolean
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
        onClick={() => activate(tab.id)}
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

/**
 * 알약 탭: 어느 쪽의 어느 폴더든 담는다. Ctrl+T(지금 위치로 새 탭)·Ctrl+W·Ctrl+Tab은 창 어디서나,
 * ←→·Home/End·Delete는 탭 줄 안에서. `paneId`를 받으면 그 패널의 탭만 보여준다(M11) —
 * 없는 쪽(기존 단일 패널 호출부)은 지금처럼 전체 탭을 그린다.
 */
export function TabStrip({ paneId }: { paneId?: string } = {}): React.JSX.Element {
  const t = useT()
  const allTabs = useTabsStore((s) => s.tabs)
  const panes = useTabsStore((s) => s.panes)
  const activeId = useTabsStore((s) => s.activeId)
  const conn = useConnection()
  const listRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  const pane = paneId === undefined ? undefined : panes.find((p) => p.id === paneId)
  const tabs = pane ? allTabs.filter((x) => x.paneId === pane.id) : allTabs
  // 패널마다 자기 활성 탭을 선택으로 보인다(M11). 패널이 없으면 기존대로 activeId.
  const selectedId = pane ? pane.activeTabId : activeId

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return
      const s = useTabsStore.getState()
      // 창 단축키는 지금 포커스가 있는 패널의 스트립만 처리한다(두 스트립이 중복 실행하지 않게).
      if (paneId !== undefined && focusedPane(s)?.id !== paneId) return
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
  }, [paneId])

  const focusTab = (i: number): void => {
    const btns = listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')
    btns?.[(i + tabs.length) % tabs.length]?.focus()
  }

  const openMenu = async (x: number, y: number): Promise<void> => {
    const { openTab } = useTabsStore.getState()
    const home = (await loadPlaces())?.home
    const locs: Loc[] = [
      ...(home ? [{ side: 'local' as const, path: home }] : []),
      ...(conn.server ? [{ side: 'remote' as const, path: '/', server: conn.server }] : [])
    ]
    setMenu({
      x,
      y,
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

  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-[var(--bd)] bg-[var(--bg)] px-3">
      <div
        ref={listRef}
        role="tablist"
        aria-label={t('tabs.label')}
        data-region={paneId === undefined ? 'tabs' : `tabs-${paneId}`}
        className="scroll flex min-w-0 items-center gap-1 overflow-x-auto py-1"
        onKeyDown={(e) => {
          const i = tabs.findIndex((x) => x.id === (e.target as HTMLElement).dataset.tab)
          if (i < 0) return
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
        {tabs.map((x) => (
          <TabPill key={x.id} tab={x} active={x.id === selectedId} closable={tabs.length > 1} />
        ))}
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
      {/* M21: 분할을 닫는控件 — 두 번째 패널의 스트립에만 뜬다(Test-937). 없으면 사용자가
          두 패널로 영영 돌아올 수 없다(M12의 결정이 제품에 없는 구멍). */}
      {pane !== undefined && panes.length === 2 && panes[1].id === pane.id && (
        <button
          onClick={() => useTabsStore.getState().closePane(pane.id)}
          aria-label={t('split.closePane')}
          title={t('split.closePane')}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
      {menu && (
        <ItemMenu
          x={menu.x}
          y={menu.y}
          label={t('tabs.new')}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
