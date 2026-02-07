import { create } from 'zustand'

type ViewMode = 'list' | 'grid'

interface SettingsStore {
  viewMode: ViewMode
  setViewMode: (mode: ViewMode) => void
  toggleViewMode: () => void
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  viewMode: 'list',

  setViewMode: (mode) => set({ viewMode: mode }),

  toggleViewMode: () => {
    set({ viewMode: get().viewMode === 'list' ? 'grid' : 'list' })
  }
}))
