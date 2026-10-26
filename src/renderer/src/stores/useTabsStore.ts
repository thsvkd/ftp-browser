import { create } from 'zustand'
import { DEFAULT_SORT, type SortSpec } from '@renderer/lib/entryList'
import { joinPath, parentPath, sameLoc, type Loc } from '@renderer/lib/explorerEntry'
import { EMPTY_FILTER, type TabFilter } from '@renderer/lib/fileCategories'
import { splitPartner } from '@renderer/lib/splitLayout'
import { useSettingsStore } from './useSettingsStore'

/** 탭 하나: 어느 쪽의 어느 폴더와, 그 탭만의 기록·선택·보기. 선택·포커스는 경로 기준이다. */
export interface Tab {
  id: string
  loc: Loc
  back: Loc[]
  fwd: Loc[]
  sel: string[]
  anchor: string | null
  focus: string | null
  /** 경로별 scrollTop. 뒤로 오면 있던 자리로 돌아간다. */
  scroll: Record<string, number>
  view: 'grid' | 'list'
  sort: SortSpec
  query: string
  /** 파일 종류 필터(카테고리·확장자). 폴더를 옮겨도 유지된다. 통째로 교체하고 제자리 수정하지 않는다. */
  filter: TabFilter
}

/** 분할 보기의 패널 id(split-view P2). 분할이 안 보일 때 하나뿐인 패널은 `'left'`다. */
export type PaneId = 'left' | 'right'

/** 분할 짝(split-view F2). 두 탭은 `tabs`에서 늘 붙어 있다(`leftId` 바로 뒤가 `rightId`, P4). */
export interface Split {
  leftId: string
  rightId: string
  /** 왼쪽 패널 비율 0~1. 그릴 때 clampRatio로 자른다(P8) */
  ratio: number
}

const MAX_BACK = 50
const MAX_RECENT = 6

interface TabsStore {
  tabs: Tab[]
  /** 활성 탭. 분할이 보이는 동안은 활성 패널의 탭이다(split-view P1). */
  activeId: string
  /** 떠난 위치, 최근 것이 앞. 중복 없음 */
  recent: Loc[]
  /**
   * 분할 짝(동시에 하나). 활성 탭이 짝의 한쪽일 때만 보인다(P14). 탭처럼 재시작 뒤 복원하지 않는다(Q2).
   */
  split: Split | null

  patchTab: (id: string, patch: Partial<Tab> | ((tab: Tab) => Partial<Tab>)) => void
  /** 활성 탭(또는 `tabId`)을 옮긴다. `select`가 있으면 그 경로를 선택한다. */
  navigate: (loc: Loc, opts?: { select?: string; tabId?: string }) => void
  /** `tabId`(없으면 활성 탭)를 뒤로. 부모로 가면 떠난 폴더를 선택한다. */
  goBack: (tabId?: string) => void
  goForward: (tabId?: string) => void
  /** `tabId`(없으면 활성 탭)를 위로. 떠난 폴더를 선택한다. */
  goUp: (tabId?: string) => void
  /** 새 탭을 끝에 연다. 보기는 설정의 `viewMode`다(활성 탭의 보기를 물려받지 않는다). 새 탭 id를 돌려준다. */
  openTab: (loc: Loc, activate?: boolean) => string
  /**
   * 마지막 탭은 닫지 않는다. 활성 탭을 닫으면 같은 자리(없으면 앞)의 탭이 활성이 된다. 짝의 반쪽을 닫으면
   * 분할이 풀리고, 그 탭이 활성이었으면 짝의 다른 반쪽이 활성이 된다.
   */
  closeTab: (id: string) => void
  activate: (id: string) => void
  cycleTab: (delta: number) => void
  /**
   * 연결 성공(MC13): 활성 탭이 `server`의 원격 탭이면 그 탭, 아니면 `server`의 첫 원격 탭을 `path`로
   * 옮기고, 그 서버의 탭이 없으면 새로 연다. 다른 서버의 탭은 옮기지 않는다(그 서버도 연결돼 있을 수
   * 있다). `activate: false`(에이전트 연결)면 활성 탭은 그대로다.
   */
  adoptRemote: (server: string, path: string, opts?: { activate?: boolean }) => void
  /** `loc`를 보는 탭을 다시 쓰거나 새로 열고, `name`이 있으면 그 항목을 선택한다. */
  showInTab: (loc: Loc, name?: string) => void
  /** 탭 `id`를 `beforeId` 앞으로(null이면 끝). 짝의 반쪽이면 짝 전체가 움직인다. 짝 사이는 짝 뒤로(P4) */
  moveTab: (id: string, beforeId: string | null) => void
  /** 드래그 놓기·"오른쪽에 분할"·⌘\의 공용 규칙(split-view §3.2) */
  placeInPane: (id: string, pane: PaneId) => void
  unsplit: () => void
  /** 좌우 바꾸기: leftId·rightId와 탭 순서를 바꾼다. ratio·activeId는 그대로 */
  swapPanes: () => void
  /** ⌘\(P5): 분할이 보이면 해제, 아니면 활성 탭을 왼쪽에 두고 이웃과 분할한다 */
  toggleSplit: () => void
  /** 0~1로 자른 값을 저장한다 */
  setSplitRatio: (ratio: number) => void
}

export type TabsState = Pick<TabsStore, 'tabs' | 'activeId' | 'split'>

/** 분할이 보이는가: 짝이 있고 활성 탭이 그 한쪽이다(P14). */
const splitShown = (s: TabsState): s is TabsState & { split: Split } =>
  !!s.split && (s.activeId === s.split.leftId || s.activeId === s.split.rightId)

/** 보이는 패널. 분할이 보이면 [left, right], 아니면 [{ pane: 'left', tabId: activeId }], 탭이 없으면 [] */
export function visiblePanes(s: TabsState): Array<{ pane: PaneId; tabId: string }> {
  if (!s.tabs.length) return []
  if (!splitShown(s)) return [{ pane: 'left', tabId: s.activeId }]
  return [
    { pane: 'left', tabId: s.split.leftId },
    { pane: 'right', tabId: s.split.rightId }
  ]
}

/** 활성 패널. 분할이 보이고 활성 탭이 오른쪽이면 `'right'`, 아니면 `'left'`(P1). */
export function activePane(s: TabsState): PaneId {
  return splitShown(s) && s.activeId === s.split.rightId ? 'right' : 'left'
}

/** `tabs`에서 두 탭의 자리를 맞바꾼다. */
function swapTabs(tabs: Tab[], a: string, b: string): Tab[] {
  const ia = tabs.findIndex((t) => t.id === a)
  const ib = tabs.findIndex((t) => t.id === b)
  const next = [...tabs]
  next[ia] = tabs[ib]
  next[ib] = tabs[ia]
  return next
}

let seq = 0

function newTab(loc: Loc, view: Tab['view']): Tab {
  return {
    id: `tab${++seq}`,
    loc,
    back: [],
    fwd: [],
    sel: [],
    anchor: null,
    focus: null,
    scroll: {},
    view,
    sort: { ...DEFAULT_SORT },
    query: '',
    filter: EMPTY_FILTER
  }
}

const selectOnly = (path: string | null): Pick<Tab, 'sel' | 'anchor' | 'focus'> => ({
  sel: path ? [path] : [],
  anchor: path,
  focus: path
})

export const useTabsStore = create<TabsStore>((set, get) => {
  const active = (): Tab | undefined => get().tabs.find((t) => t.id === get().activeId)
  /** `tabId`의 탭, 없으면 활성 탭(split-view P13) */
  const byId = (tabId?: string): Tab | undefined =>
    tabId ? get().tabs.find((t) => t.id === tabId) : active()

  return {
    tabs: [],
    activeId: '',
    recent: [],
    split: null,

    patchTab: (id, patch) =>
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t
        )
      })),

    navigate: (loc, opts) => {
      const t = opts?.tabId ? get().tabs.find((x) => x.id === opts.tabId) : active()
      if (!t) return
      const same = sameLoc(t.loc, loc)
      if (same && !opts?.select) return
      if (!same)
        set((s) => ({
          recent: [t.loc, ...s.recent.filter((r) => !sameLoc(r, t.loc))].slice(0, MAX_RECENT)
        }))
      get().patchTab(t.id, {
        loc,
        back: same ? t.back : [...t.back, t.loc].slice(-MAX_BACK),
        fwd: same ? t.fwd : [],
        ...selectOnly(opts?.select ?? null),
        query: ''
      })
    },

    goBack: (tabId) => {
      const t = byId(tabId)
      const prev = t?.back.at(-1)
      if (!t || !prev) return
      // 부모로 돌아오면 떠난 폴더를 선택한다(탐색기·Finder처럼).
      const isParent = prev.side === t.loc.side && parentPath(t.loc.side, t.loc.path) === prev.path
      get().patchTab(t.id, {
        loc: prev,
        back: t.back.slice(0, -1),
        fwd: [t.loc, ...t.fwd],
        ...selectOnly(isParent ? t.loc.path : null),
        query: ''
      })
    },

    goForward: (tabId) => {
      const t = byId(tabId)
      const next = t?.fwd[0]
      if (!t || !next) return
      get().patchTab(t.id, {
        loc: next,
        back: [...t.back, t.loc].slice(-MAX_BACK),
        fwd: t.fwd.slice(1),
        ...selectOnly(null),
        query: ''
      })
    },

    goUp: (tabId) => {
      const t = byId(tabId)
      if (!t) return
      const up = parentPath(t.loc.side, t.loc.path)
      if (up !== null) get().navigate({ ...t.loc, path: up }, { select: t.loc.path, tabId: t.id })
    },

    openTab: (loc, activate = true) => {
      const t = newTab(loc, useSettingsStore.getState().viewMode)
      set((s) => ({ tabs: [...s.tabs, t], activeId: activate || !s.activeId ? t.id : s.activeId }))
      return t.id
    },

    closeTab: (id) => {
      const { tabs, activeId, split } = get()
      if (tabs.length <= 1) return
      const i = tabs.findIndex((t) => t.id === id)
      if (i < 0) return
      const rest = tabs.filter((t) => t.id !== id)
      const half = split && (id === split.leftId || id === split.rightId)
      const other = half ? (id === split.leftId ? split.rightId : split.leftId) : null
      set({
        tabs: rest,
        activeId: activeId !== id ? activeId : (other ?? rest[Math.min(i, rest.length - 1)].id),
        split: half ? null : split
      })
    },

    activate: (id) => set({ activeId: id }),

    cycleTab: (delta) => {
      const { tabs, activeId } = get()
      if (!tabs.length) return
      const i = tabs.findIndex((t) => t.id === activeId)
      set({ activeId: tabs[(((i + delta) % tabs.length) + tabs.length) % tabs.length].id })
    },

    adoptRemote: (server, path, opts) => {
      const activate = opts?.activate ?? true
      const loc: Loc = { side: 'remote', path, server }
      const mine = (t: Tab | undefined): boolean =>
        t?.loc.side === 'remote' && t.loc.server === server
      const current = active()
      const target = mine(current) ? current : get().tabs.find(mine)
      if (!target) {
        get().openTab(loc, activate)
        return
      }
      get().navigate(loc, { tabId: target.id })
      if (activate) set({ activeId: target.id })
    },

    showInTab: (loc, name) => {
      const existing = get().tabs.find((t) => sameLoc(t.loc, loc))
      const id = existing ? existing.id : get().openTab(loc)
      set({ activeId: id })
      if (name) get().patchTab(id, selectOnly(joinPath(loc.side, loc.path, name)))
    },

    moveTab: (id, beforeId) => {
      const { tabs, split } = get()
      const unit =
        split && (id === split.leftId || id === split.rightId)
          ? [split.leftId, split.rightId]
          : [id]
      if (beforeId !== null && unit.includes(beforeId)) return
      const moving = tabs.filter((t) => unit.includes(t.id))
      const rest = tabs.filter((t) => !unit.includes(t.id))
      // 짝 사이(오른쪽 반쪽 앞)로는 끼어들 수 없다: 짝 뒤로 간다.
      const at =
        beforeId === null
          ? rest.length
          : rest.findIndex((t) => t.id === beforeId) + (beforeId === split?.rightId ? 1 : 0)
      if (!moving.length || at < 0) return
      set({ tabs: [...rest.slice(0, at), ...moving, ...rest.slice(at)] })
    },

    placeInPane: (id, pane) => {
      const s = get()
      if (s.tabs.length < 2 || !s.tabs.some((t) => t.id === id)) return
      if (splitShown(s)) {
        const { split } = s
        const here = pane === 'left' ? split.leftId : split.rightId
        if (id === here) return
        if (id === split.leftId || id === split.rightId) {
          get().swapPanes()
          set({ activeId: id })
          return
        }
        // 짝 밖의 탭: 그 패널의 탭과 순서에서 자리를 바꾸고 패널을 넘겨받는다.
        set({
          tabs: swapTabs(s.tabs, here, id),
          split: pane === 'left' ? { ...split, leftId: id } : { ...split, rightId: id },
          activeId: id
        })
        return
      }
      // 숨은 짝은 푼다(분할은 하나, Q3). 끈 탭을 짝 옆으로 옮긴다.
      const partner = splitPartner(
        s.tabs.map((t) => t.id),
        s.activeId,
        id
      )
      if (!partner) return
      const tab = s.tabs.find((t) => t.id === id)!
      const rest = s.tabs.filter((t) => t.id !== id)
      const at = rest.findIndex((t) => t.id === partner) + (pane === 'right' ? 1 : 0)
      set({
        tabs: [...rest.slice(0, at), tab, ...rest.slice(at)],
        split:
          pane === 'right'
            ? { leftId: partner, rightId: id, ratio: 0.5 }
            : { leftId: id, rightId: partner, ratio: 0.5 },
        activeId: id
      })
    },

    unsplit: () => set({ split: null }),

    swapPanes: () => {
      const { tabs, split } = get()
      if (!split) return
      set({
        tabs: swapTabs(tabs, split.leftId, split.rightId),
        split: { ...split, leftId: split.rightId, rightId: split.leftId }
      })
    },

    toggleSplit: () => {
      const s = get()
      if (splitShown(s)) s.unsplit()
      else s.placeInPane(s.activeId, 'left')
    },

    setSplitRatio: (ratio) => {
      const { split } = get()
      if (split) set({ split: { ...split, ratio: Math.min(Math.max(ratio, 0), 1) } })
    }
  }
})

/** 활성 탭. 시작 직후(홈 경로를 받기 전)에는 없다. */
export const useActiveTab = (): Tab | undefined =>
  useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId))
