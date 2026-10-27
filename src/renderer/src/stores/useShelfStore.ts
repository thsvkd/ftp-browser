import { create } from 'zustand'
import { locKey, type ExplorerEntry } from '@renderer/lib/explorerEntry'

/** 선반에 담긴 항목. 폴더 크기는 합산하지 않는다(원격 LIST는 폴더 크기가 0이다). */
export interface ShelfItem {
  entry: ExplorerEntry
}

interface ShelfStore {
  items: ShelfItem[]
  /** 하단 섬을 패널로 펼쳤는지. 담아도 바뀌지 않는다 — 접힌 캡슐이 늘 보이고 거기서 보낸다(I8). */
  dockOpen: boolean
  /** 같은 `side+server+path`는 한 번만 담는다. 새로 담은 수를 돌려준다. */
  add: (entries: readonly ExplorerEntry[]) => number
  /** `locKey(entry)`로 뺀다. */
  remove: (keys: readonly string[]) => void
  clear: () => void
  setDockOpen: (open: boolean) => void
  toggleDock: () => void
}

export const useShelfStore = create<ShelfStore>((set, get) => ({
  items: [],
  dockOpen: false,

  add: (entries) => {
    const have = new Set(get().items.map((i) => locKey(i.entry)))
    const fresh: ShelfItem[] = []
    for (const entry of entries) {
      const key = locKey(entry)
      if (have.has(key)) continue
      have.add(key)
      fresh.push({ entry })
    }
    if (fresh.length) set((s) => ({ items: [...s.items, ...fresh] }))
    return fresh.length
  },

  remove: (keys) => {
    const drop = new Set(keys)
    set((s) => ({ items: s.items.filter((i) => !drop.has(locKey(i.entry))) }))
  },

  clear: () => set({ items: [] }),

  setDockOpen: (dockOpen) => set({ dockOpen }),

  toggleDock: () => set((s) => ({ dockOpen: !s.dockOpen }))
}))
