import { create } from 'zustand'
import { getParentPath } from '@renderer/lib/localPath'
import type { LocalFileEntry } from '@shared/types/local'
import type { IpcResult } from '@shared/types/ipc'

interface LocalListData {
  path: string
  entries: LocalFileEntry[]
}

interface LocalFsStore {
  currentPath: string
  entries: LocalFileEntry[]
  loading: boolean
  error: string | null

  init: () => Promise<void>
  navigateTo: (path: string) => Promise<void>
  navigateUp: () => Promise<void>
  refresh: () => Promise<void>
}

export const useLocalFsStore = create<LocalFsStore>((set, get) => ({
  currentPath: '',
  entries: [],
  loading: false,
  error: null,

  init: async () => {
    const result = await window.api.invoke<IpcResult<string>>('local:getHome')
    if (result.success) {
      await get().navigateTo(result.data)
    }
  },

  navigateTo: async (path) => {
    set({ loading: true, error: null })
    try {
      const result = await window.api.invoke<IpcResult<LocalListData>>('local:list', path)
      if (result.success) {
        set({
          currentPath: path,
          entries: result.data.entries,
          loading: false
        })
      } else {
        set({ error: result.error, loading: false })
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false })
    }
  },

  navigateUp: async () => {
    const { currentPath } = get()
    const parent = getParentPath(currentPath)
    if (parent) await get().navigateTo(parent)
  },

  refresh: async () => {
    await get().navigateTo(get().currentPath)
  }
}))
