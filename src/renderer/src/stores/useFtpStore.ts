import { create } from 'zustand'
import type {
  FtpConnectPayload,
  FtpFileEntry,
  FtpConnectionState,
  ConnectionStatus
} from '@shared/types/ftp'
import { connKey } from '@shared/connKey'
import { ErrorCode, type IpcResult } from '@shared/types/ipc'
import { t } from '@renderer/i18n'
import { fromFtpEntry } from '@renderer/lib/explorerEntry'
import { useListingStore } from './useListingStore'
import { useTabsStore } from './useTabsStore'

interface FtpListData {
  path: string
  entries: FtpFileEntry[]
}

interface FtpStore {
  // Connection state
  connectionStatus: ConnectionStatus
  host: string
  port: number
  /** 연결한 사용자 이름. 서버 키 `"user@host:port"`(D1)를 만든다. */
  username: string
  error: string | null

  // Actions
  connect: (config: FtpConnectPayload, initialPath?: string) => Promise<boolean>
  disconnect: () => Promise<void>
  /**
   * Main changed the connection by itself (an agent, handoff agent-access K5): reset the
   * session state like `disconnect()` without asking main to disconnect, then take `session`.
   */
  adoptSession: (session: {
    status: ConnectionStatus
    host?: string
    port?: number
    user?: string
  }) => void
  setConnectionState: (state: FtpConnectionState) => void
}

/**
 * connect()가 await 중일 때 disconnect()가 오면, 늦게 도착한 성공/실패를
 * 커밋하지 않기 위한 세대 번호. UI에 노출하지 않는다.
 */
let connectGeneration = 0

/** 원격 폴더 하나를 읽는다. 호출이 던지면 실패 값으로 바꾼다. */
async function listDir(path: string): Promise<IpcResult<FtpListData>> {
  try {
    return await window.api.invoke<IpcResult<FtpListData>>('ftp:list', path)
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 연결이 없을 때의 세션 상태. disconnect()와 adoptSession()이 같은 초기화를 쓴다. */
const DISCONNECTED = {
  connectionStatus: 'disconnected',
  host: '',
  port: 21,
  username: '',
  error: null
} satisfies Partial<FtpStore>

export const useFtpStore = create<FtpStore>((set, get) => ({
  connectionStatus: 'disconnected',
  host: '',
  port: 21,
  username: '',
  error: null,

  connect: async (config, initialPath = '/') => {
    const generation = ++connectGeneration
    set({ error: null })
    const result = await window.api.invoke<IpcResult<void>>('ftp:connect', config)
    if (generation !== connectGeneration) return false
    if (result.success) {
      set({ host: config.host, port: config.port, username: config.user })
      // 시작 폴더를 읽지 못하면 루트로 물러선다.
      let path = initialPath
      let listed = await listDir(path)
      if (generation !== connectGeneration) return false
      if (!listed.success && path !== '/') {
        path = '/'
        listed = await listDir(path)
        if (generation !== connectGeneration) return false
      }
      if (!listed.success) {
        set({ error: listed.error })
        return false
      }
      // 확정된 시작 폴더의 목록을 캐시에 넣고 원격 탭 하나를 그리로 옮겨 활성화한다(D3).
      const server = connKey(config.host, config.port, config.user)
      useListingStore.getState().put(
        { side: 'remote', path, server },
        listed.data.entries.map((e) => fromFtpEntry(e, path, server))
      )
      useTabsStore.getState().adoptRemote(server, path)
      return true
    }
    // 저장된 비밀번호를 이 컴퓨터에서 풀 수 없으면 다시 입력하라고 알린다(E12).
    set({
      error:
        result.code === ErrorCode.SAVED_PASSWORD_UNREADABLE
          ? t('connect.savedPasswordUnreadable')
          : result.error
    })
    return false
  },

  disconnect: async () => {
    connectGeneration++
    await window.api.invoke('ftp:disconnect')
    set(DISCONNECTED)
  },

  adoptSession: (session) => {
    // 진행 중이던 목록 요청은 이전 세션의 것이므로 버린다.
    connectGeneration++
    set({
      ...DISCONNECTED,
      connectionStatus: session.status,
      host: session.host ?? '',
      port: session.port ?? 21,
      username: session.user ?? ''
    })
  },

  setConnectionState: (state) => {
    set({
      connectionStatus: state.status,
      host: state.host ?? get().host,
      error: state.error ?? null
    })
  }
}))
