import { create } from 'zustand'
import type {
  FtpConnectPayload,
  FtpFileEntry,
  FtpConnectionState,
  ConnectionStatus
} from '@shared/types/ftp'
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
  /** 세션별 상태(M6). 키는 서버 키 `"user@host:port"`(M1). 한 세션이 다른 세션을 덮지 않는다. */
  sessions: Record<string, FtpConnectionState>
  /** 가장 최근에 시도/성공한 세션의 키(M3). 없으면 null. */
  primaryServer: string | null

  // Connection state — primary 세션의 투영(M6): 기존 소비자(툴바·상태바)가 그대로 쓴다.
  connectionStatus: ConnectionStatus
  host: string
  port: number
  /** 연결한 사용자 이름. 서버 키 `"user@host:port"`(D1)를 만든다. */
  username: string
  error: string | null

  // Actions
  connect: (config: FtpConnectPayload, initialPath?: string) => Promise<boolean>
  /** 인자가 없으면 primary만 끊는다. 주면 그 세션만 끊는다(M1·M3). */
  disconnect: (server?: string) => Promise<void>
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

/** 서버 키(M1): main의 FtpSessionRegistry와 같은 `"user@host:port"`. */
function serverKeyOf(config: Pick<FtpConnectPayload, 'user' | 'host' | 'port'>): string {
  return `${config.user}@${config.host}:${config.port}`
}

/** 연결이 없을 때의 세션 상태. disconnect()와 adoptSession()이 같은 초기화를 쓴다. */
const DISCONNECTED = {
  connectionStatus: 'disconnected',
  host: '',
  port: 21,
  username: '',
  error: null
} satisfies Partial<FtpStore>

/** primary 세션 키. 세션 기록이 없으면 지금 연결의 필드로 만든다(투영만으로 연결된 상태). */
function primaryServerKey(s: {
  primaryServer: string | null
  connectionStatus: ConnectionStatus
  username: string
  host: string
  port: number
}): string | null {
  if (s.primaryServer !== null) return s.primaryServer
  return s.connectionStatus === 'connected' ? `${s.username}@${s.host}:${s.port}` : null
}

/**
 * M7: 그 서버가 연결돼 있는가. 원격 탭 게이트와 전송 계획이 이것을 쓴다 —
 * "지금 active 세션과 같은가"가 아니라 "그 서버의 세션이 열려 있는가".
 * `server`가 null·undefined면 로컬이라 세션이 필요 없다(항상 true).
 */
export function isConnectedServer(server: string | null | undefined): boolean {
  if (server === null || server === undefined) return true
  const s = useFtpStore.getState()
  const session = s.sessions[server]
  if (session) return session.status === 'connected'
  // 세션 기록이 없으면(이전 방식으로만 연결된 상태) primary 투영으로 판단한다.
  return s.connectionStatus === 'connected' && primaryServerKey(s) === server
}

/** M7: 하나라도 연결된 세션이 있다. 원격 탭이 '다른 서버' 패널을 띄우는 기준. */
export function hasConnectedSession(): boolean {
  const s = useFtpStore.getState()
  return (
    s.connectionStatus === 'connected' ||
    Object.values(s.sessions).some((session) => session.status === 'connected')
  )
}

export const useFtpStore = create<FtpStore>((set, get) => ({
  sessions: {},
  primaryServer: null,
  connectionStatus: 'disconnected',
  host: '',
  port: 21,
  username: '',
  error: null,

  connect: async (config, initialPath = '/') => {
    const generation = ++connectGeneration
    const server = serverKeyOf(config)
    set({ error: null, primaryServer: server }) // M3: 가장 최근에 시도한 세션이 primary다
    const result = await window.api.invoke<IpcResult<void>>('ftp:connect', config)
    if (generation !== connectGeneration) return false
    if (result.success) {
      // 투영 갱신과 함께 이 세션을 sessions에 남긴다(M6): 둘 다 connected로 남는다(Test-914).
      set((s) => ({
        host: config.host,
        port: config.port,
        username: config.user,
        sessions: {
          ...s.sessions,
          [server]: {
            status: 'connected',
            host: config.host,
            port: config.port,
            username: config.user,
            server
          }
        }
      }))
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

  disconnect: async (server) => {
    connectGeneration++
    if (server === undefined) await window.api.invoke('ftp:disconnect')
    else await window.api.invoke('ftp:disconnect', server)
    set((s) => {
      const key = server ?? s.primaryServer
      const sessions =
        key === null
          ? s.sessions
          : Object.fromEntries(Object.entries(s.sessions).filter(([k]) => k !== key))
      // primary(또는 인자 없는 해제)는 투영까지 비운다. 다른 세션만 끊으면 투영은 그대로다.
      if (server !== undefined && server !== s.primaryServer) return { sessions }
      return { ...DISCONNECTED, sessions, primaryServer: null }
    })
  },

  adoptSession: (session) => {
    // 진행 중이던 목록 요청은 이전 세션의 것이므로 버린다.
    connectGeneration++
    const s = get()
    if (session.status === 'disconnected') {
      const key = s.primaryServer
      set({
        ...DISCONNECTED,
        ...(key !== null && {
          sessions: Object.fromEntries(Object.entries(s.sessions).filter(([k]) => k !== key))
        }),
        primaryServer: null
      })
      return
    }
    const key =
      session.host !== undefined
        ? serverKeyOf({
            user: session.user ?? '',
            host: session.host,
            port: session.port ?? 21
          })
        : s.primaryServer
    set({
      ...DISCONNECTED,
      connectionStatus: session.status,
      host: session.host ?? '',
      port: session.port ?? 21,
      username: session.user ?? '',
      primaryServer: key,
      ...(key !== null && {
        sessions: {
          ...s.sessions,
          [key]: {
            status: session.status,
            host: session.host,
            port: session.port,
            username: session.user,
            server: key
          }
        }
      })
    })
  },

  setConnectionState: (state) => {
    const s = get()
    // M5: 태그가 있으면 그 세션의 상태를 갱신하고, primary 투영은 primary 세션일 때만 바꾼다(함정 D).
    const key = state.server ?? s.primaryServer
    const isPrimary = state.server === undefined || state.server === s.primaryServer
    set((cur) => ({
      ...(key !== null && {
        sessions: {
          ...cur.sessions,
          [key]: {
            ...cur.sessions[key],
            ...state,
            server: key,
            host: state.host ?? cur.sessions[key]?.host
          }
        }
      }),
      ...(isPrimary && {
        connectionStatus: state.status,
        host: state.host ?? cur.host,
        error: state.error ?? null
      })
    }))
  }
}))
