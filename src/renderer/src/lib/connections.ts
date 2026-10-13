/**
 * 연결 상태 셀렉터(multi-connection §3). `useFtpStore.connections`의 키(ConnKey)마다 상태가 있다.
 * 키 순서는 `connections`에 처음 들어온 순서(`Object.keys`)다.
 */
import { useMemo } from 'react'
import { useFtpStore, type ConnInfo } from '@renderer/stores/useFtpStore'
import { parseConnKey, type ConnKey } from '@shared/connKey'
import type { ConnectionStatus, FtpConnectPayload, FtpServer } from '@shared/types/ftp'

const keysOf = (connections: Record<ConnKey, ConnInfo>): ConnKey[] =>
  Object.keys(connections).filter((k) => connections[k].status === 'connected')

/** 그 연결의 상태. 항목이 없으면(한 번도 잇지 않았으면) `'disconnected'`. */
export function connStatus(server: ConnKey | undefined): ConnectionStatus {
  return (server && useFtpStore.getState().connections[server]?.status) || 'disconnected'
}

/** 렌더 중에 쓰는 `connStatus`. */
export function useConnStatus(server: ConnKey | undefined): ConnectionStatus {
  return useFtpStore((s) => (server && s.connections[server]?.status) || 'disconnected')
}

/** 연결된 키들(`connections`에 들어온 순서). */
export function connectedKeys(): ConnKey[] {
  return keysOf(useFtpStore.getState().connections)
}

/**
 * 렌더 중에 쓰는 연결된 키 집합. 키를 이은 문자열 하나를 구독하므로 진행률 갱신에는 다시 그려지지
 * 않고, 매번 새 집합을 돌려주는 셀렉터의 무한 렌더도 없다.
 */
export function useConnectedKeys(): ReadonlySet<ConnKey> {
  const joined = useFtpStore((s) => keysOf(s.connections).join('\n'))
  return useMemo(() => new Set(joined ? joined.split('\n') : []), [joined])
}

/** 그 키의 저장된 서버(같은 호스트·포트·사용자). 익명은 빈 사용자 이름으로도 저장된다. */
export function savedServerOf(servers: readonly FtpServer[], key: ConnKey): FtpServer | undefined {
  const parsed = parseConnKey(key)
  if (!parsed) return undefined
  const { user, host, port } = parsed
  return servers.find(
    (s) =>
      s.host === host && s.port === port && (s.username || 'anonymous') === (user || 'anonymous')
  )
}

/** 저장된 서버에 저장된 비밀번호로 잇는 요청(main이 비밀번호를 읽는다). */
export function payloadOf(saved: FtpServer): FtpConnectPayload {
  return {
    id: saved.id,
    name: saved.name,
    host: saved.host,
    port: saved.port,
    user: saved.username || 'anonymous',
    savedPasswordOf: saved.id,
    secure: saved.secure,
    ...(saved.maxTransfers !== undefined && { maxTransfers: saved.maxTransfers })
  }
}
