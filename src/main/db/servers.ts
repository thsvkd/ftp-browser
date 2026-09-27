import type Database from 'better-sqlite3'
import { ErrorCode, type ErrorCodeType } from '@shared/types/ipc'
import type { FtpConnectPayload, FtpServer } from '@shared/types/ftp'

/** A save the renderer can explain in its own language: `code` picks the message. */
export class ServerSaveError extends Error {
  constructor(
    readonly code: ErrorCodeType,
    message: string
  ) {
    super(message)
  }
}

interface ServerRow {
  id: number
  name: string
  host: string
  port: number
  username: string | null
  password_enc: string | null
  secure: number
  last_connected: string | null
}

const isValidPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= 65535

/**
 * 연결하지 않고 저장만 한다. `last_connected`는 건드리지 않는다.
 * - `id`가 있으면 그 행을 고친다. 주소(host:port)가 바뀌면 최근 경로도 따라 옮긴다.
 * - `id`가 없으면 새로 만든다. 같은 주소의 서버가 이미 있으면 덮어쓰지 않고 거절한다.
 * 호스트는 대소문자를 가리지 않고 비교한다(예전 행에는 'NAS.local'처럼 대문자가 남아 있다).
 */
export function saveServer(db: Database.Database, server: FtpServer): FtpServer {
  const host = server.host.trim()
  if (!isValidPort(server.port)) {
    throw new ServerSaveError(ErrorCode.INVALID_PORT, `Invalid port: ${server.port}`)
  }
  const fields = [
    server.name.trim(),
    host,
    server.port,
    server.username,
    server.password,
    server.secure ? 1 : 0
  ]

  const id = db.transaction((): number => {
    const old =
      server.id === undefined
        ? undefined
        : (db.prepare('SELECT host, port FROM servers WHERE id = ?').get(server.id) as
            | { host: string; port: number }
            | undefined)
    if (server.id !== undefined && !old) {
      throw new ServerSaveError(ErrorCode.SERVER_NOT_FOUND, 'This server is no longer saved.')
    }
    // 주소가 사실상 그대로면(대소문자만 다름) 충돌을 보지 않는다. 예전에 대소문자만 다른
    // 두 행('NAS.local', 'nas.local')이 남아 있어도 각각 고칠 수 있어야 한다.
    const sameAddress =
      old && old.port === server.port && old.host.toLowerCase() === host.toLowerCase()
    if (!sameAddress) {
      const clash = db
        .prepare('SELECT 1 FROM servers WHERE lower(host) = lower(?) AND port = ? AND id IS NOT ?')
        .get(host, server.port, server.id ?? null)
      if (clash) {
        throw new ServerSaveError(
          ErrorCode.SERVER_EXISTS,
          `Another saved server already uses ${host}:${server.port}.`
        )
      }
    }

    if (!old || server.id === undefined) {
      return Number(
        db
          .prepare(
            'INSERT INTO servers (name, host, port, username, password_enc, secure) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(...fields).lastInsertRowid
      )
    }

    db.prepare(
      'UPDATE servers SET name = ?, host = ?, port = ?, username = ?, password_enc = ?, secure = ? WHERE id = ?'
    ).run(...fields, server.id)
    if (old.host !== host || old.port !== server.port) {
      // 새 주소에 남은 고아 경로가 있으면 UNIQUE에 걸리므로 덮어쓴다.
      db.prepare(
        'UPDATE OR REPLACE server_recent_paths SET server_host = ?, server_port = ? WHERE server_host = ? AND server_port = ?'
      ).run(host, server.port, old.host, old.port)
    }
    return server.id
  })()

  const row = db
    .prepare(
      'SELECT id, name, host, port, username, password_enc, secure, last_connected FROM servers WHERE id = ?'
    )
    .get(id) as ServerRow
  return toServer(row)
}

/**
 * 연결에 성공했다는 기록. 마지막 연결 시각을 찍는다.
 * - `id`가 있으면(저장된 서버를 저장된 계정으로 연결) 그 서버의 계정·보안 설정을 갱신하고,
 *   별칭은 비어 있지 않을 때만 바꾼다.
 * - `id`가 없는데 같은 주소의 저장된 서버가 있으면(다른 계정·익명으로 연결) 그 서버의
 *   계정은 건드리지 않고 연결 시각만 찍는다. 없으면 새 서버로 저장한다.
 * 익명 로그인의 기본값('anonymous' / 'anonymous@')은 저장하지 않는다.
 */
export function recordConnection(db: Database.Database, payload: FtpConnectPayload): void {
  const anonymous = /^anonymous$/i.test(payload.user.trim())
  const user = anonymous ? '' : payload.user
  const password = anonymous && payload.password === 'anonymous@' ? '' : payload.password
  const name = payload.name?.trim() ?? ''
  const secure = payload.secure ? 1 : 0

  db.transaction(() => {
    if (payload.id !== undefined) {
      const updated = db
        .prepare(
          `UPDATE servers SET
             name = CASE WHEN ? <> '' THEN ? ELSE name END,
             username = ?, password_enc = ?, secure = ?, last_connected = datetime('now')
           WHERE id = ?`
        )
        .run(name, name, user, password, secure, payload.id)
      if (updated.changes > 0) return
    }
    const touched = db
      .prepare(
        "UPDATE servers SET last_connected = datetime('now') WHERE lower(host) = lower(?) AND port = ?"
      )
      .run(payload.host, payload.port)
    if (touched.changes > 0) return
    db.prepare(
      `INSERT INTO servers (name, host, port, username, password_enc, secure, last_connected)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(name, payload.host, payload.port, user, password, secure)
  })()
}

export function toServer(r: ServerRow): FtpServer {
  return {
    id: r.id,
    // 별칭 기능 이전에는 name에 host를 그대로 넣었다. 그런 행은 별칭 없음으로 본다.
    name: r.name === r.host ? '' : r.name,
    host: r.host,
    port: r.port,
    username: r.username || '',
    password: r.password_enc || '',
    secure: r.secure === 1,
    lastConnected: r.last_connected ?? undefined
  }
}

/** 마지막 연결 순. 연결한 적 없는 서버(NULL)는 SQLite DESC 정렬에서 맨 뒤로 간다. */
export function listServers(db: Database.Database): FtpServer[] {
  const rows = db
    .prepare(
      'SELECT id, name, host, port, username, password_enc, secure, last_connected FROM servers ORDER BY last_connected DESC, id DESC'
    )
    .all() as ServerRow[]
  return rows.map(toServer)
}
