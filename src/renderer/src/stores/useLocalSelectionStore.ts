import { create } from 'zustand'

interface LocalSelectionStore {
  selectedNames: Set<string>
  lastClickedName: string | null

  selectSingle: (name: string) => void
  toggleSelect: (name: string) => void
  selectRange: (name: string, sortedNames: string[]) => void
  selectAll: (names: string[]) => void
  clearSelection: () => void
}

export const useLocalSelectionStore = create<LocalSelectionStore>((set, get) => ({
  selectedNames: new Set(),
  lastClickedName: null,

  selectSingle: (name) => {
    set({ selectedNames: new Set([name]), lastClickedName: name })
  },

  toggleSelect: (name) => {
    const next = new Set(get().selectedNames)
    if (next.has(name)) {
      next.delete(name)
    } else {
      next.add(name)
    }
    set({ selectedNames: next, lastClickedName: name })
  },

  selectRange: (name, sortedNames) => {
    const { lastClickedName, selectedNames } = get()
    if (!lastClickedName) {
      set({ selectedNames: new Set([name]), lastClickedName: name })
      return
    }
    const startIdx = sortedNames.indexOf(lastClickedName)
    const endIdx = sortedNames.indexOf(name)
    if (startIdx === -1 || endIdx === -1) {
      set({ selectedNames: new Set([name]), lastClickedName: name })
      return
    }
    const lo = Math.min(startIdx, endIdx)
    const hi = Math.max(startIdx, endIdx)
    const rangeNames = sortedNames.slice(lo, hi + 1)
    const next = new Set(selectedNames)
    for (const n of rangeNames) {
      next.add(n)
    }
    set({ selectedNames: next })
  },

  selectAll: (names) => {
    set({ selectedNames: new Set(names) })
  },

  clearSelection: () => {
    set({ selectedNames: new Set(), lastClickedName: null })
  }
}))
