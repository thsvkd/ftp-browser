import { create } from 'zustand'

export type ViewMode = 'list' | 'grid' | 'gallery'

interface SettingsStore {
  remoteViewMode: ViewMode
  localViewMode: ViewMode
  setRemoteViewMode: (mode: ViewMode) => void
  setLocalViewMode: (mode: ViewMode) => void
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  remoteViewMode: 'list',
  localViewMode: 'list',

  setRemoteViewMode: (mode) => set({ remoteViewMode: mode }),
  setLocalViewMode: (mode) => set({ localViewMode: mode })
}))
