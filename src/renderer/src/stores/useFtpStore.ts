import { create } from 'zustand'
import type {
  FtpConnectPayload,
  FtpFileEntry,
  FtpConnectionState,
  ConnectionStatus
} from '@shared/types/ftp'
import { connKey, parseConnKey, type ConnKey } from '@shared/connKey'
import { ErrorCode, type IpcResult } from '@shared/types/ipc'
import { t } from '@renderer/i18n'
import { fromFtpEntry } from '@renderer/lib/explorerEntry'
import { useListingStore } from './useListingStore'
import { useTabsStore } from './useTabsStore'

interface FtpListData {
  path: string
  entries: FtpFileEntry[]
}

/** 연결 하나의 상태(MC10). 끊긴 연결도 지우지 않고 `'disconnected'`로 남긴다. */
export interface ConnInfo {
  status: ConnectionStatus
  host: string
  port: number
  user: string
  error: string | null
}

interface FtpStore {
  /** 연결 키(`"user@host:port"`)별 상태. 키 순서는 처음 들어온 순서다. */
  connections: Record<ConnKey, ConnInfo>

  /**
   * `config`의 서버에 연결한다. 다른 연결은 건드리지 않는다. `adopt`(기본 true)면 시작 폴더를 읽어
   * 그 서버의 원격 탭으로 옮긴다(D3·MC13). 자동 연결은 `adopt: false`로 연결만 한다.
   */
  connect: (
    config: FtpConnectPayload,
    initialPath?: string,
    opts?: { adopt?: boolean }
  ) => Promise<boolean>
  /** 그 연결만 끊는다. 연결 중이면 그 시도를 버린다. */
  disconnect: (server: ConnKey) => Promise<void>
  /**
   * Main changed a connection by itself (an agent, handoff agent-access K5): take the event's
   * state for that key only, dropping any connect of the GUI that is still in flight for it.
   */
  adoptSession: (session: {
    server: ConnKey
    status: ConnectionStatus
    host?: string
    port?: number
    user?: string
  }) => void
  setConnectionState: (state: FtpConnectionState) => void
}

/**
 * 키별 세대 번호. connect()가 await 중일 때 그 키의 disconnect()가 오면 늦게 도착한 성공/실패를
 * 커밋하지 않는다. UI에 노출하지 않는다.
 */
const connectGeneration = new Map<ConnKey, number>()
const bump = (server: ConnKey): number => {
  const next = (connectGeneration.get(server) ?? 0) + 1
  connectGeneration.set(server, next)
  return next
}

/** 원격 폴더 하나를 읽는다. 호출이 던지면 실패 값으로 바꾼다. */
async function listDir(server: ConnKey, path: string): Promise<IpcResult<FtpListData>> {
  try {
    return await window.api.invoke<IpcResult<FtpListData>>('ftp:list', server, path)
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 키에서 호스트·포트·사용자를 꺼낸 항목. 형식이 틀린 키면 빈 값이다. */
function infoOf(server: ConnKey, status: ConnectionStatus): ConnInfo {
  const parsed = parseConnKey(server)
  return {
    status,
    host: parsed?.host ?? '',
    port: parsed?.port ?? 21,
    user: parsed?.user ?? '',
    error: null
  }
}

export const useFtpStore = create<FtpStore>((set, get) => {
  /** 그 키의 항목만 바꾼다(없으면 키에서 만든다). */
  const patch = (server: ConnKey, fields: Partial<ConnInfo>): void =>
    set((s) => ({
      connections: {
        ...s.connections,
        [server]: { ...(s.connections[server] ?? infoOf(server, 'disconnected')), ...fields }
      }
    }))

  return {
    connections: {},

    connect: async (config, initialPath = '/', opts) => {
      const server = connKey(config.host, config.port, config.user)
      const generation = bump(server)
      // 시도하는 서버를 먼저 둔다: 연결 중에 취소(disconnect)하면 이 키를 끊는다.
      const before = get().connections[server]?.status
      patch(server, {
        status: before === 'connected' ? 'connected' : 'connecting',
        host: config.host,
        port: config.port,
        user: config.user,
        error: null
      })
      const result = await window.api.invoke<IpcResult<void>>('ftp:connect', config)
      if (generation !== connectGeneration.get(server)) return false
      if (!result.success) {
        // 저장된 비밀번호를 이 컴퓨터에서 풀 수 없으면 다시 입력하라고 알린다(E12).
        patch(server, {
          status: 'error',
          error:
            result.code === ErrorCode.SAVED_PASSWORD_UNREADABLE
              ? t('connect.savedPasswordUnreadable')
              : result.error
        })
        return false
      }
      patch(server, { status: 'connected' })
      if (opts?.adopt === false) return true
      // 시작 폴더를 읽지 못하면 루트로 물러선다.
      let path = initialPath
      let listed = await listDir(server, path)
      if (generation !== connectGeneration.get(server)) return false
      if (!listed.success && path !== '/') {
        path = '/'
        listed = await listDir(server, path)
        if (generation !== connectGeneration.get(server)) return false
      }
      if (!listed.success) {
        patch(server, { error: listed.error })
        return false
      }
      // 확정된 시작 폴더의 목록을 캐시에 넣고 그 서버의 원격 탭을 그리로 옮겨 활성화한다(MC13).
      useListingStore.getState().put(
        { side: 'remote', path, server },
        listed.data.entries.map((e) => fromFtpEntry(e, path, server))
      )
      useTabsStore.getState().adoptRemote(server, path)
      return true
    },

    disconnect: async (server) => {
      bump(server)
      await window.api.invoke('ftp:disconnect', server)
      patch(server, { status: 'disconnected', error: null })
    },

    adoptSession: (session) => {
      // 진행 중이던 그 키의 연결·목록 요청은 이전 세션의 것이므로 버린다.
      bump(session.server)
      const base = infoOf(session.server, session.status)
      patch(session.server, {
        ...base,
        host: session.host ?? base.host,
        port: session.port ?? base.port,
        user: session.user ?? base.user
      })
    },

    setConnectionState: (state) => {
      patch(state.server, {
        status: state.status,
        host: state.host,
        port: state.port,
        user: state.user,
        error: state.error ?? null
      })
    }
  }
})
