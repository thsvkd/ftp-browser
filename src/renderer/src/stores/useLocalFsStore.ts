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

  // Path history
  history: string[]
  historyIndex: number

  init: () => Promise<void>
  navigateTo: (path: string) => Promise<void>
  navigateUp: () => Promise<void>
  goBack: () => Promise<void>
  goForward: () => Promise<void>
  refresh: () => Promise<void>
}

type FetchOutcome = { ok: true; entries: LocalFileEntry[] } | { ok: false; error: string }

async function fetchListing(path: string): Promise<FetchOutcome> {
  try {
    const result = await window.api.invoke<IpcResult<LocalListData>>('local:list', path)
    if (result.success) return { ok: true, entries: result.data.entries }
    return { ok: false, error: result.error }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export const useLocalFsStore = create<LocalFsStore>((set, get) => ({
  currentPath: '',
  entries: [],
  loading: false,
  error: null,
  history: [],
  historyIndex: -1,

  init: async () => {
    const result = await window.api.invoke<IpcResult<string>>('local:getHome')
    if (result.success) {
      await get().navigateTo(result.data)
    }
  },

  navigateTo: async (path) => {
    set({ loading: true, error: null })
    const outcome = await fetchListing(path)
    if (!outcome.ok) {
      set({ error: outcome.error, loading: false })
      return
    }
    const { history, historyIndex } = get()
    const newHistory = [...history.slice(0, historyIndex + 1), path]
    set({
      currentPath: path,
      entries: outcome.entries,
      loading: false,
      history: newHistory,
      historyIndex: newHistory.length - 1
    })
  },

  navigateUp: async () => {
    const { currentPath } = get()
    const parent = getParentPath(currentPath)
    if (parent) await get().navigateTo(parent)
  },

  goBack: async () => {
    const { history, historyIndex } = get()
    if (historyIndex <= 0) return
    const newIndex = historyIndex - 1
    const path = history[newIndex]
    set({ loading: true, error: null })
    const outcome = await fetchListing(path)
    if (!outcome.ok) {
      set({ error: outcome.error, loading: false })
      return
    }
    set({
      currentPath: path,
      entries: outcome.entries,
      loading: false,
      historyIndex: newIndex
    })
  },

  goForward: async () => {
    const { history, historyIndex } = get()
    if (historyIndex >= history.length - 1) return
    const newIndex = historyIndex + 1
    const path = history[newIndex]
    set({ loading: true, error: null })
    const outcome = await fetchListing(path)
    if (!outcome.ok) {
      set({ error: outcome.error, loading: false })
      return
    }
    set({
      currentPath: path,
      entries: outcome.entries,
      loading: false,
      historyIndex: newIndex
    })
  },

  refresh: async () => {
    // Silent refresh — loading 플래그를 켜지 않아 컴포넌트가 unmount되지 않음.
    const path = get().currentPath
    set({ error: null })
    const outcome = await fetchListing(path)
    if (!outcome.ok) {
      set({ error: outcome.error })
      return
    }
    set({ entries: outcome.entries })
  }
}))
