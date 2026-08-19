import { create } from 'zustand'
import type {
  FtpConnectPayload,
  FtpFileEntry,
  FtpConnectionState,
  ConnectionStatus
} from '@shared/types/ftp'
import type { IpcResult } from '@shared/types/ipc'

interface FtpListData {
  path: string
  entries: FtpFileEntry[]
}

interface FtpStore {
  // Connection state
  connectionStatus: ConnectionStatus
  host: string
  port: number
  error: string | null

  // Directory state
  currentPath: string
  entries: FtpFileEntry[]
  loading: boolean

  // Path history
  history: string[]
  historyIndex: number

  // Actions
  connect: (config: FtpConnectPayload, initialPath?: string) => Promise<boolean>
  disconnect: () => Promise<void>
  navigateTo: (path: string) => Promise<void>
  navigateUp: () => Promise<void>
  goBack: () => Promise<void>
  goForward: () => Promise<void>
  refresh: () => Promise<void>
  setConnectionState: (state: FtpConnectionState) => void
}

/**
 * connect()가 await 중일 때 disconnect()가 오면, 늦게 도착한 성공/실패를
 * 커밋하지 않기 위한 세대 번호. UI에 노출하지 않는다.
 */
let connectGeneration = 0

export const useFtpStore = create<FtpStore>((set, get) => ({
  connectionStatus: 'disconnected',
  host: '',
  port: 21,
  error: null,
  currentPath: '/',
  entries: [],
  loading: false,
  history: ['/'],
  historyIndex: 0,

  connect: async (config, initialPath = '/') => {
    const generation = ++connectGeneration
    set({ error: null })
    const result = await window.api.invoke<IpcResult<void>>('ftp:connect', config)
    if (generation !== connectGeneration) return false
    if (result.success) {
      set({ host: config.host, port: config.port })
      await get().navigateTo(initialPath)
      if (generation !== connectGeneration) {
        set({ error: null, loading: false })
        return false
      }
      // If initial path failed, fall back to root
      if (get().error && initialPath !== '/') {
        set({ error: null })
        await get().navigateTo('/')
        if (generation !== connectGeneration) {
          set({ error: null, loading: false })
          return false
        }
      }
      if (get().error) {
        return false
      }
      return true
    }
    set({ error: result.error })
    return false
  },

  disconnect: async () => {
    connectGeneration++
    await window.api.invoke('ftp:disconnect')
    set({
      connectionStatus: 'disconnected',
      host: '',
      port: 21,
      currentPath: '/',
      entries: [],
      error: null,
      loading: false,
      history: ['/'],
      historyIndex: 0
    })
  },

  navigateTo: async (path) => {
    const generation = connectGeneration
    set({ loading: true, error: null })
    try {
      const result = await window.api.invoke<IpcResult<FtpListData>>('ftp:list', path)
      if (generation !== connectGeneration) return
      if (result.success) {
        const { history, historyIndex } = get()
        const newHistory = [...history.slice(0, historyIndex + 1), path]
        set({
          currentPath: path,
          entries: result.data.entries,
          loading: false,
          history: newHistory,
          historyIndex: newHistory.length - 1
        })
      } else {
        set({ error: result.error, loading: false })
      }
    } catch (err) {
      if (generation !== connectGeneration) return
      set({
        error: err instanceof Error ? err.message : String(err),
        loading: false
      })
    }
  },

  navigateUp: async () => {
    const { currentPath } = get()
    if (currentPath === '/') return
    const parts = currentPath.split('/').filter(Boolean)
    parts.pop()
    const parentPath = '/' + parts.join('/')
    await get().navigateTo(parentPath)
  },

  goBack: async () => {
    const { history, historyIndex } = get()
    if (historyIndex <= 0) return
    const newIndex = historyIndex - 1
    const path = history[newIndex]
    set({ loading: true, error: null })
    try {
      const result = await window.api.invoke<IpcResult<FtpListData>>('ftp:list', path)
      if (result.success) {
        set({
          currentPath: path,
          entries: result.data.entries,
          loading: false,
          historyIndex: newIndex
        })
      } else {
        set({ error: result.error, loading: false })
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false })
    }
  },

  goForward: async () => {
    const { history, historyIndex } = get()
    if (historyIndex >= history.length - 1) return
    const newIndex = historyIndex + 1
    const path = history[newIndex]
    set({ loading: true, error: null })
    try {
      const result = await window.api.invoke<IpcResult<FtpListData>>('ftp:list', path)
      if (result.success) {
        set({
          currentPath: path,
          entries: result.data.entries,
          loading: false,
          historyIndex: newIndex
        })
      } else {
        set({ error: result.error, loading: false })
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false })
    }
  },

  refresh: async () => {
    // Silent refresh — same path 재로딩 시 loading 플래그를 켜지 않음.
    // 그리드/리스트 컴포넌트가 unmount되지 않아 화면 깜빡임이 사라진다.
    const path = get().currentPath
    try {
      const result = await window.api.invoke<IpcResult<FtpListData>>('ftp:list', path)
      if (result.success) {
        set({ entries: result.data.entries, error: null })
      } else {
        set({ error: result.error })
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  setConnectionState: (state) => {
    set({
      connectionStatus: state.status,
      host: state.host ?? get().host,
      error: state.error ?? null
    })
  }
}))
