import { create } from 'zustand'
import { DEFAULT_SORT, type SortSpec } from '@renderer/lib/entryList'
import { joinPath, parentPath, sameLoc, type Loc } from '@renderer/lib/explorerEntry'
import { useSettingsStore } from './useSettingsStore'

/** 탭 하나: 어느 쪽의 어느 폴더와, 그 탭만의 기록·선택·보기. 선택·포커스는 경로 기준이다. */
export interface Tab {
  id: string
  /** 이 탭이 속한 패널(M10). 탭 배열은 그대로 두고 소속만 표시한다. */
  paneId: string
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
  photosOnly: boolean
}

/** 패널 하나(M10). 길이 1~2. `tabIds`는 `tabs`의 `paneId`로도 보지만 바로 보기 위해 함께 둔다. */
export interface Pane {
  id: string
  tabIds: string[]
  activeTabId: string
}

const MAX_BACK = 50
const MAX_RECENT = 6

interface TabsStore {
  tabs: Tab[]
  panes: Pane[]
  /** 지금 포커스가 있는 패널의 활성 탭(M11) — 기존 소비자(단축키·툴바)는 이 의미를 그대로 쓴다. */
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
  /** 지금 포커스가 있는 패널에 새 탭을 끝에 연다. 보기는 활성 탭(없으면 설정의 `viewMode`)을 물려받는다. 새 탭 id를 돌려준다. */
  openTab: (loc: Loc, activate?: boolean) => string
  /** 마지막 탭은 닫지 않는다. 활성 탭을 닫으면 같은 자리(없으면 앞)의 탭이 활성이 된다. */
  closeTab: (id: string) => void
  activate: (id: string) => void
  cycleTab: (delta: number) => void
  /**
   * `paneId` 쪽을 분할해 두 번째 패널을 만든다(M13). 새 패널 id. 이미 두 패널이면 빈 문자열.
   * `pending`이 있으면 그 위치의 자리표시자 탭으로 깔고(연결이 끝나면 `adoptRemote`가 채운다),
   * `side`는 호버한 절반(M15) — 왼쪽이면 새 패널을 앞에 놓는다.
   */
  split: (paneId: string, opts?: { pending?: Loc; side?: 'left' | 'right' }) => string
  /** 패널을 닫고 그 탭을 남은 패널로 옮긴다(M12). 마지막 패널은 닫히지 않는다. */
  closePane: (paneId: string) => void
  /** 그 패널을 포커스한다 — `activeId`를 그 패널의 활성 탭으로 바꾼다(M11). */
  activatePane: (paneId: string) => void
  /**
   * 연결 성공(D3): 그 세션의 탭(활성 → 다른 패널)을 `server`의 `path`로 옮기고, 없으면 자기 패널의
   * 첫 원격 탭을 옮긴다(함정 H — 다른 패널의 탭은 같은 세션일 때만 고른다). 원격 탭이 없으면 새로
   * 연다. `activate: false`(에이전트 연결)면 활성 탭은 그대로다.
   */
  adoptRemote: (server: string, path: string, opts?: { activate?: boolean }) => void
  /** `loc`를 보는 탭을 다시 쓰거나 새로 열고, `name`이 있으면 그 항목을 선택한다. */
  showInTab: (loc: Loc, name?: string) => void
}

let seq = 0
/** 시작 패널은 `pane1`. 분할이 늘어나는 id는 여기서 이어 붙인다(테스트가 `pane1`로 되돌려도 안 겹친다). */
let paneSeq = 1

function newTab(loc: Loc, view: Tab['view'], paneId: string): Tab {
  return {
    id: `tab${++seq}`,
    paneId,
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
    photosOnly: false
  }
}

const selectOnly = (path: string | null): Pick<Tab, 'sel' | 'anchor' | 'focus'> => ({
  sel: path ? [path] : [],
  anchor: path,
  focus: path
})

/** `tabs`에서 그 패널의 탭 id 목록을 다시 만든다 — 직접 setState로 섞여도 어긋나지 않는다. */
const idsIn = (tabs: Tab[], paneId: string): string[] =>
  tabs.filter((t) => t.paneId === paneId).map((t) => t.id)

/**
 * M11: 지금 포커스가 있는 패널 — `activeId` 탭이 속한 패널. 그 탭이 없으면(시작 직후) 첫 패널.
 */
export function focusedPane(s: { tabs: Tab[]; panes: Pane[]; activeId: string }): Pane | undefined {
  const tab = s.tabs.find((t) => t.id === s.activeId)
  const id = tab?.paneId ?? s.panes[0]?.id
  return s.panes.find((p) => p.id === id) ?? s.panes[0]
}

export const useTabsStore = create<TabsStore>((set, get) => {
  const active = (): Tab | undefined => get().tabs.find((t) => t.id === get().activeId)

  return {
    tabs: [],
    panes: [{ id: 'pane1', tabIds: [], activeTabId: '' }],
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
      const s = get()
      // 새 탭은 지금 포커스가 있는 패널에 연다(탭 조작은 자기 패널 범위에서만 돈다).
      const pane = focusedPane(s)
      if (!pane) return ''
      const view = active()?.view ?? useSettingsStore.getState().viewMode
      const t = newTab(loc, view, pane.id)
      const on = activate || !s.activeId
      set((cur) => {
        const tabs = [...cur.tabs, t]
        return {
          tabs,
          panes: cur.panes.map((p) =>
            p.id === pane.id
              ? { ...p, tabIds: idsIn(tabs, p.id), activeTabId: on ? t.id : p.activeTabId }
              : { ...p, tabIds: idsIn(tabs, p.id) }
          ),
          activeId: on ? t.id : cur.activeId
        }
      })
      return t.id
    },

    closeTab: (id) => {
      const s = get()
      const tab = s.tabs.find((t) => t.id === id)
      if (!tab) return
      const pane = s.panes.find((p) => p.id === tab.paneId)
      if (!pane) return
      // 패널마다 마지막 탭은 닫지 않는다(기존 "마지막 탭은 닫지 않는다"를 패널 단위로).
      const inPane = s.tabs.filter((t) => t.paneId === pane.id)
      if (inPane.length <= 1) return
      const i = inPane.findIndex((t) => t.id === id)
      const rest = inPane.filter((t) => t.id !== id)
      const nextActive = rest[Math.min(i, rest.length - 1)].id
      const tabs = s.tabs.filter((t) => t.id !== id)
      set({
        tabs,
        panes: s.panes.map((p) =>
          p.id === pane.id
            ? {
                ...p,
                tabIds: idsIn(tabs, p.id),
                activeTabId: p.activeTabId === id ? nextActive : p.activeTabId
              }
            : { ...p, tabIds: idsIn(tabs, p.id) }
        ),
        activeId: s.activeId === id ? nextActive : s.activeId
      })
    },

    activate: (id) =>
      set((s) => {
        const tab = s.tabs.find((t) => t.id === id)
        if (!tab) return { activeId: id }
        // 활성 탭이 속한 패널이 포커스 패널이 된다(activeId가 그 의미).
        return {
          activeId: id,
          panes: s.panes.map((p) => (p.id === tab.paneId ? { ...p, activeTabId: id } : p))
        }
      }),

    cycleTab: (delta) => {
      const s = get()
      // 순환은 포커스 패널의 탭 목록 안에서만 돈다(M11).
      const pane = focusedPane(s)
      const list = pane ? s.tabs.filter((t) => t.paneId === pane.id) : s.tabs
      if (!list.length) return
      const i = list.findIndex((t) => t.id === s.activeId)
      const next = list[(((i + delta) % list.length) + list.length) % list.length]
      set((cur) => ({
        activeId: next.id,
        panes: cur.panes.map((p) => (pane && p.id === pane.id ? { ...p, activeTabId: next.id } : p))
      }))
    },

    split: (paneId, opts) => {
      const s = get()
      if (s.panes.length >= 2) return '' // M10: 패널은 1~2개
      const source = s.panes.find((p) => p.id === paneId) ?? s.panes[0]
      const srcTab = s.tabs.find((t) => t.id === source?.activeTabId) ?? active()
      const loc = opts?.pending ?? srcTab?.loc
      if (!source || !loc) return ''
      // M13: 분할된 쪽 자리에 새 탭 하나. `pending`(Phase C)이 있으면 그 서버의 자리표시자로
      // 깔고, 연결이 끝나면 adoptRemote가 제자리(그 서버 탭)로 채운다.
      const t = newTab(
        loc,
        srcTab?.view ?? useSettingsStore.getState().viewMode,
        `pane${++paneSeq}`
      )
      const pane: Pane = { id: t.paneId, tabIds: [t.id], activeTabId: t.id }
      // M15: 호버한 쪸(side)에 패널이 생긴다 — 왼쪽이면 앞에 놓는다.
      const at = opts?.side === 'left' ? s.panes.indexOf(source) : -1
      set((cur) => ({
        tabs: [...cur.tabs, t],
        panes:
          at < 0 ? [...cur.panes, pane] : [...cur.panes.slice(0, at), pane, ...cur.panes.slice(at)],
        activeId: t.id
      }))
      return pane.id
    },

    closePane: (paneId) => {
      const s = get()
      if (s.panes.length <= 1) return // M12: 마지막 패널은 닫히지 않는다
      const closing = s.tabs.find((t) => t.id === s.activeId)?.paneId === paneId
      const keep = s.panes.find((p) => p.id !== paneId)
      if (!keep) return
      // M12: 남은 패널로 탭을 옮긴다 — 탭을 하나도 잃지 않는다.
      const tabs = s.tabs.map((t) => (t.paneId === paneId ? { ...t, paneId: keep.id } : t))
      const keepTabs = tabs.filter((t) => t.paneId === keep.id)
      const next = keepTabs.find((t) => t.id === keep.activeTabId) ?? keepTabs[0]
      set({
        tabs,
        panes: [{ ...keep, tabIds: idsIn(tabs, keep.id) }],
        activeId: closing ? (next?.id ?? s.activeId) : s.activeId
      })
    },

    activatePane: (paneId) => {
      const s = get()
      const pane = s.panes.find((p) => p.id === paneId)
      if (!pane) return
      const tabs = s.tabs.filter((t) => t.paneId === paneId)
      const tab = tabs.find((t) => t.id === pane.activeTabId) ?? tabs[0]
      if (!tab) return
      if (s.activeId === tab.id && pane.activeTabId === tab.id) return
      set((cur) => ({
        activeId: tab.id,
        panes: cur.panes.map((p) => (p.id === paneId ? { ...p, activeTabId: tab.id } : p))
      }))
    },

    adoptRemote: (server, path, opts) => {
      const activate = opts?.activate ?? true
      const loc: Loc = { side: 'remote', path, server }
      const s = get()
      const current = s.tabs.find((t) => t.id === s.activeId)
      const pane = focusedPane(s)
      const sameSession = (t: Tab): boolean => t.loc.side === 'remote' && t.loc.server === server
      const target =
        (current && sameSession(current) ? current : undefined) ??
        // 함정 H: 다른 패널의 탭은 같은 세션일 때만 고른다 — 한쪽 패널의 연결이 다른 패널의
        // 탭을 가져가지 않는다. 자기 패널 안에서는 D3(첫 원격 탭)를 그대로 따른다.
        s.tabs.find((t) => sameSession(t) && t.paneId !== pane?.id) ??
        s.tabs.find((t) => t.loc.side === 'remote' && t.paneId === pane?.id)
      if (!target) {
        get().openTab(loc, activate)
        return
      }
      get().navigate(loc, { tabId: target.id })
      if (activate) get().activate(target.id)
    },

    showInTab: (loc, name) => {
      const existing = get().tabs.find((t) => sameLoc(t.loc, loc))
      const id = existing ? existing.id : get().openTab(loc)
      get().activate(id)
      if (name) get().patchTab(id, selectOnly(joinPath(loc.side, loc.path, name)))
    }
  }
})

/** 활성 탭. 시작 직후(홈 경로를 받기 전)에는 없다. */
export const useActiveTab = (): Tab | undefined =>
  useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId))
