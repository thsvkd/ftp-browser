import {
  deleteServer,
  getRecentPaths,
  getServerById,
  listServers,
  recordConnection
} from '../../db/servers'
import { DEFAULT_MAX_TRANSFERS, type FtpConnectPayload, type FtpServer } from '@shared/types/ftp'
import { AgentError, type AgentServices, type SavedServerInfo, type ServerRef } from '../types'
import { checkRemotePath } from './paths'
import type { AgentServiceDeps } from './index'

/** 비밀번호를 빼고 필드를 하나씩 옮긴다. 펼침(...)으로 복사하면 비밀번호가 따라 나간다(M11). */
function toInfo(s: FtpServer): SavedServerInfo {
  return {
    id: s.id!,
    name: s.name,
    host: s.host,
    port: s.port,
    user: s.username,
    secure: s.secure,
    maxTransfers: s.maxTransfers ?? DEFAULT_MAX_TRANSFERS,
    lastConnected: s.lastConnected
  }
}

function label(s: FtpServer): string {
  return `${s.name || s.host} (id ${s.id}, ${s.host}:${s.port})`
}

export function createServersService({
  db
}: Pick<AgentServiceDeps, 'db'>): AgentServices['servers'] {
  /** id, 별칭, 호스트, `host:port` 순으로 찾는다. 대소문자는 가리지 않는다. 숫자 문자열은 id로도 본다. */
  const resolve = (ref: ServerRef): SavedServerInfo => {
    const servers = listServers(db)
    let matches: FtpServer[]
    if (typeof ref === 'number') {
      matches = servers.filter((s) => s.id === ref)
    } else {
      const q = ref.trim().toLowerCase()
      matches = servers.filter((s) => s.name.toLowerCase() === q)
      if (matches.length === 0) {
        matches = servers.filter(
          (s) => s.host.toLowerCase() === q || `${s.host}:${s.port}`.toLowerCase() === q
        )
      }
      if (matches.length === 0 && /^\d+$/.test(q)) {
        matches = servers.filter((s) => s.id === Number(q))
      }
    }
    if (matches.length === 1) return toInfo(matches[0])
    const saved = servers.map(label).join(', ') || 'none'
    throw new AgentError(
      'NOT_FOUND',
      matches.length > 1
        ? `${JSON.stringify(ref)} matches ${matches.length} saved servers; use the id. Saved servers: ${saved}.`
        : `No saved server matches ${JSON.stringify(ref)}. Saved servers: ${saved}.`
    )
  }

  return {
    list: () => listServers(db).map(toInfo),
    resolve,
    remove: (id) => {
      resolve(id) // 없는 id면 저장된 이름을 담은 NOT_FOUND
      deleteServer(db, id)
    }
  }
}

export function createSessionService(
  deps: Pick<AgentServiceDeps, 'db' | 'ftp' | 'queue' | 'operations' | 'events'>,
  servers: AgentServices['servers']
): AgentServices['session'] {
  const { db, ftp, queue, operations, events } = deps

  // T1: 서버를 바꾸면 진행 중인 전송·작업이 끊기거나 엉뚱한 서버로 간다
  const isBusy = (): boolean =>
    queue.getAll().some((j) => j.status === 'pending' || j.status === 'active') ||
    operations.getAll().some((o) => o.status === 'active')

  return {
    info: () => {
      const status = ftp.getStatus()
      if (!ftp.isConnected()) return { status }
      const host = ftp.getHost()
      const port = ftp.getPort()
      const saved = listServers(db).find(
        (s) => s.host.toLowerCase() === host.toLowerCase() && s.port === port
      )
      return { status, serverId: saved?.id, host, port, user: ftp.getUser() }
    },

    // GUI 연결 흐름(useServerStore.connect → useFtpStore.connect)을 main에서 다시 구현한다(S1).
    connect: async (ref, requestedPath) => {
      const wanted = requestedPath === undefined ? undefined : checkRemotePath(requestedPath)
      if (isBusy()) {
        throw new AgentError(
          'BUSY',
          'Transfers or file operations are still running. Wait for them to finish or cancel them before connecting.'
        )
      }
      const server = getServerById(db, servers.resolve(ref).id)!
      // 저장된 서버를 저장된 계정으로 연결하므로 id를 보낸다(GUI의 sameAccount와 같다)
      const payload: FtpConnectPayload = {
        id: server.id,
        name: server.name,
        host: server.host,
        port: server.port,
        user: server.username || 'anonymous',
        password: server.password || 'anonymous@',
        secure: server.secure,
        maxTransfers: server.maxTransfers
      }
      const result = await ftp.connect(payload)
      if (!result.success) {
        throw new Error(
          result.cancelled ? 'Connection cancelled' : (result.error ?? 'Connection failed')
        )
      }
      try {
        recordConnection(db, payload)
      } catch (err) {
        // ftp:connect와 같이 저장 실패로 연결을 실패시키지 않는다
        console.warn('[agent] Failed to persist server info:', err)
      }

      // T2: 지정한 폴더, 없으면 마지막으로 연 폴더. 열 수 없으면 GUI처럼 루트로 간다.
      const start = wanted ?? getRecentPaths(db, server.host, server.port)[0]?.path ?? '/'
      let opened = start
      try {
        await ftp.list(start)
      } catch (err) {
        if (start === '/') throw err
        await ftp.list('/')
        opened = '/'
      }
      events.session({
        status: 'connected',
        serverId: server.id,
        host: server.host,
        port: server.port,
        user: payload.user,
        path: opened
      })
      return { path: opened }
    },

    disconnect: async () => {
      await ftp.disconnect()
      events.session({ status: 'disconnected' })
    }
  }
}
