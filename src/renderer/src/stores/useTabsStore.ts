import { create } from 'zustand'
import { DEFAULT_SORT, type SortSpec } from '@renderer/lib/entryList'
import { joinPath, parentPath, sameLoc, type Loc } from '@renderer/lib/explorerEntry'
import { EMPTY_FILTER, type TabFilter } from '@renderer/lib/fileCategories'
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

const MAX_BACK = 50
const MAX_RECENT = 6

interface TabsStore {
  tabs: Tab[]
  activeId: string
  /** 떠난 위치, 최근 것이 앞. 중복 없음 */
  recent: Loc[]

  patchTab: (id: string, patch: Partial<Tab> | ((tab: Tab) => Partial<Tab>)) => void
  /** 활성 탭(또는 `tabId`)을 옮긴다. `select`가 있으면 그 경로를 선택한다. */
  navigate: (loc: Loc, opts?: { select?: string; tabId?: string }) => void
  /** 뒤로. 부모로 가면 떠난 폴더를 선택한다. */
  goBack: () => void
  goForward: () => void
  /** 위로. 떠난 폴더를 선택한다. */
  goUp: () => void
  /** 새 탭을 끝에 연다. 보기는 활성 탭(없으면 설정의 `viewMode`)을 물려받는다. 새 탭 id를 돌려준다. */
  openTab: (loc: Loc, activate?: boolean) => string
  /** 마지막 탭은 닫지 않는다. 활성 탭을 닫으면 같은 자리(없으면 앞)의 탭이 활성이 된다. */
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

  return {
    tabs: [],
    activeId: '',
    recent: [],

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

    goBack: () => {
      const t = active()
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

    goForward: () => {
      const t = active()
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

    goUp: () => {
      const t = active()
      if (!t) return
      const up = parentPath(t.loc.side, t.loc.path)
      if (up !== null) get().navigate({ ...t.loc, path: up }, { select: t.loc.path })
    },

    openTab: (loc, activate = true) => {
      const t = newTab(loc, active()?.view ?? useSettingsStore.getState().viewMode)
      set((s) => ({ tabs: [...s.tabs, t], activeId: activate || !s.activeId ? t.id : s.activeId }))
      return t.id
    },

    closeTab: (id) => {
      const { tabs, activeId } = get()
      if (tabs.length <= 1) return
      const i = tabs.findIndex((t) => t.id === id)
      if (i < 0) return
      const rest = tabs.filter((t) => t.id !== id)
      set({
        tabs: rest,
        activeId: activeId === id ? rest[Math.min(i, rest.length - 1)].id : activeId
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
    }
  }
})

/** 활성 탭. 시작 직후(홈 경로를 받기 전)에는 없다. */
export const useActiveTab = (): Tab | undefined =>
  useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId))
