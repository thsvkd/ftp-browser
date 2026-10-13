import { parseConnKey, type ConnKey } from '@shared/connKey'
import type { FtpServer } from '@shared/types/ftp'
import { listServers } from '../db/servers'
import { AgentError, resolveServer, type AgentDeps, type AgentSession } from './agentOps'

/** 그 연결의 저장 행: 같은 host(대소문자 무시)·port에 사용자까지 같은 행, 없으면 host·port만 같은 행 */
export function savedOf(servers: FtpServer[], key: ConnKey): FtpServer | undefined {
  const { host, port, user } = parseConnKey(key)!
  const at = servers.filter((s) => s.host.toLowerCase() === host.toLowerCase() && s.port === port)
  return at.find((s) => (s.username || 'anonymous') === user) ?? at[0]
}

/** `이름 (id N, user@host:port)`, 저장되지 않은 연결은 `host (user@host:port)` */
function describe(servers: FtpServer[], key: ConnKey): string {
  const saved = savedOf(servers, key)
  if (saved) return `${saved.name || saved.host} (id ${saved.id}, ${key})`
  return `${parseConnKey(key)!.host} (${key})`
}

/** 저장 서버의 연결: 사용자까지 같은 것, 없으면 그 host:port의 유일한 연결 */
function connectionOf(deps: AgentDeps, server: FtpServer): ConnKey {
  const connected = deps.connections.connectedKeys()
  const at = connected.filter((key) => {
    const { host, port } = parseConnKey(key)!
    return host.toLowerCase() === server.host.toLowerCase() && port === server.port
  })
  const user = server.username || 'anonymous'
  const exact = at.find((key) => parseConnKey(key)!.user === user)
  if (exact) return exact
  if (at.length === 1) return at[0]
  if (at.length === 0) {
    throw new AgentError(
      'NOT_CONNECTED',
      `${server.name || server.host} (id ${server.id}, ${server.host}:${server.port}) is not ` +
        `connected. Call connect with server ${server.id} first.`
    )
  }
  const servers = listServers(deps.db)
  throw new AgentError(
    'AMBIGUOUS',
    `${at.length} connections match ${server.name || server.host}: ` +
      `${at.map((key) => describe(servers, key)).join(', ')}.`
  )
}

/** `get_status`가 보인 끊긴 연결의 키면 NOT_FOUND(저장 서버 검색) 대신 NOT_CONNECTED로 알린다. */
function refuseDisconnectedKey(deps: AgentDeps, ref: string): void {
  const state = deps.connections.states().find((s) => s.server.toLowerCase() === ref)
  if (!state) return
  const saved = savedOf(listServers(deps.db), state.server)
  throw new AgentError(
    'NOT_CONNECTED',
    `${state.server} is not connected. ` +
      (saved
        ? `Call connect with server ${saved.id} first.`
        : 'It is not a saved server; connect to it in FTP Browser first.')
  )
}

/**
 * 도구가 쓸 연결(multi-connection MC18). ① `server` 인자: 연결 키(대소문자 무시) 또는 저장 서버의 연결.
 * 그것이 마지막 사용 연결이 된다. ② 인자가 없으면 마지막 사용 연결이 아직 연결돼 있으면 그것.
 * ③ 연결이 정확히 하나면 그것. ④ 0개면 NOT_CONNECTED, 둘 이상이면 AMBIGUOUS.
 */
export function resolveTarget(deps: AgentDeps, server?: number | string): ConnKey {
  const connected = deps.connections.connectedKeys()
  if (server !== undefined) {
    const ref = String(server).trim().toLowerCase()
    const known = connected.find((k) => k.toLowerCase() === ref)
    if (known === undefined) refuseDisconnectedKey(deps, ref)
    const key = known ?? connectionOf(deps, resolveServer(deps.db, server))
    deps.target.last = key
    return key
  }
  const { last } = deps.target
  if (last !== undefined && connected.includes(last)) return last
  if (connected.length === 1) return connected[0]
  if (connected.length === 0) {
    throw new AgentError('NOT_CONNECTED', 'FTP Browser is not connected to an FTP server.')
  }
  const servers = listServers(deps.db)
  throw new AgentError(
    'AMBIGUOUS',
    `${connected.length} servers are connected: ` +
      `${connected.map((key) => describe(servers, key)).join(', ')}.`
  )
}

/** 대상 연결의 세션 */
export function targetSession(deps: AgentDeps, server?: number | string): AgentSession {
  return deps.connections.get(resolveTarget(deps, server))!
}
