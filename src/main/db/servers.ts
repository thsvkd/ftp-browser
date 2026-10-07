import type Database from 'better-sqlite3'
import { ErrorCode, type ErrorCodeType } from '@shared/types/ipc'
import {
  DEFAULT_MAX_TRANSFERS,
  isValidMaxTransfers,
  type FtpConnectPayload,
  type FtpServer,
  type FtpServerInput,
  type RecentPath
} from '@shared/types/ftp'

/** A save the renderer can explain in its own language: `code` picks the message. */
export class ServerSaveError extends Error {
  constructor(
    readonly code: ErrorCodeType,
    message: string
  ) {
    super(message)
  }
}

/**
 * 저장된 비밀번호를 어떻게 쓸지(E3). 암호화는 passwordVault가 트랜잭션 밖에서 먼저 끝낸다
 * (better-sqlite3 트랜잭션 안에서는 await할 수 없다).
 * - `keep`: 그대로 둔다(새 서버면 비밀번호 없음)
 * - `clear`: 두 컬럼을 모두 비운다
 * - `cipher`: 암호문을 `password_cipher`에 쓰고 예전 평문(`password_enc`)은 비운다
 * - `plain`: 암호화를 쓸 수 없을 때만. 평문을 `password_enc`에 쓴다(예전과 같음)
 */
export type PasswordWrite =
  | { kind: 'keep' }
  | { kind: 'clear' }
  | { kind: 'cipher'; cipher: Buffer }
  | { kind: 'plain'; password: string }

export const KEEP_PASSWORD: PasswordWrite = { kind: 'keep' }
const CLEAR_PASSWORD: PasswordWrite = { kind: 'clear' }

/**
 * 비밀번호가 저장돼 있는지. 암호문(`password_cipher`)이나 예전 평문(`password_enc`) 중 하나다(E1).
 * 목록은 이 식만 읽으므로 비밀번호 값은 main 안에서도 서버 목록을 따라다니지 않는다.
 */
export const HAS_PASSWORD_SQL = "(password_cipher IS NOT NULL OR IFNULL(password_enc, '') <> '')"

const SERVER_COLUMNS = `id, name, host, port, username, ${HAS_PASSWORD_SQL} AS has_password, secure, max_transfers, last_connected`

interface ServerRow {
  id: number
  name: string
  host: string
  port: number
  username: string | null
  has_password: number
  secure: number
  max_transfers: number
  last_connected: string | null
}

/** `keep`이 아니면 두 비밀번호 컬럼을 함께 쓴다. 한 행에서 둘 중 하나만 값을 가진다(E1). */
function writePassword(db: Database.Database, id: number, write: PasswordWrite): void {
  if (write.kind === 'keep') return
  db.prepare('UPDATE servers SET password_enc = ?, password_cipher = ? WHERE id = ?').run(
    write.kind === 'plain' ? write.password : null,
    write.kind === 'cipher' ? write.cipher : null,
    id
  )
}

const isValidPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= 65535

/**
 * 연결하지 않고 저장만 한다. `last_connected`는 건드리지 않는다.
 * - `id`가 있으면 그 행을 고친다. 주소(host:port)가 바뀌면 최근 경로도 따라 옮긴다.
 * - `id`가 없으면 새로 만든다. 같은 주소의 서버가 이미 있으면 덮어쓰지 않고 거절한다.
 * 호스트는 대소문자를 가리지 않고 비교한다(예전 행에는 'NAS.local'처럼 대문자가 남아 있다).
 * 비밀번호는 `password`대로 쓴다. 돌려주는 서버에는 저장 여부(`hasPassword`)만 있다.
 * 저장된 비밀번호를 그대로 둔 채(`keep`) 주소를 옮기려 하면 거절한다(E16).
 */
export function saveServer(
  db: Database.Database,
  server: Omit<FtpServerInput, 'password'>,
  password: PasswordWrite
): FtpServer {
  const host = server.host.trim()
  if (!isValidPort(server.port)) {
    throw new ServerSaveError(ErrorCode.INVALID_PORT, `Invalid port: ${server.port}`)
  }
  if (server.maxTransfers !== undefined && !isValidMaxTransfers(server.maxTransfers)) {
    throw new ServerSaveError(
      ErrorCode.INVALID_MAX_TRANSFERS,
      `Invalid max transfers: ${server.maxTransfers}`
    )
  }
  const fields = [server.name.trim(), host, server.port, server.username, server.secure ? 1 : 0]

  const id = db.transaction((): number => {
    const old =
      server.id === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT host, port, ${HAS_PASSWORD_SQL} AS has_password FROM servers WHERE id = ?`
            )
            .get(server.id) as { host: string; port: number; has_password: number } | undefined)
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
      // 저장된 비밀번호는 저장한 주소에만 쓴다(E15). 주소를 옮기면서 그대로 두면 다른 서버로 간다(E16).
      if (old?.has_password === 1 && password.kind === 'keep') {
        throw new ServerSaveError(
          ErrorCode.SAVED_PASSWORD_ADDRESS_CHANGED,
          'Enter the password again for the new address, or remove it.'
        )
      }
    }

    if (!old || server.id === undefined) {
      const id = Number(
        db
          .prepare(
            'INSERT INTO servers (name, host, port, username, secure, max_transfers) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(...fields, server.maxTransfers ?? DEFAULT_MAX_TRANSFERS).lastInsertRowid
      )
      writePassword(db, id, password)
      return id
    }

    // 동시 전송 수가 빠진 저장은 recordConnection처럼 저장된 값을 그대로 둔다
    db.prepare(
      'UPDATE servers SET name = ?, host = ?, port = ?, username = ?, secure = ?, max_transfers = COALESCE(?, max_transfers) WHERE id = ?'
    ).run(...fields, server.maxTransfers ?? null, server.id)
    writePassword(db, server.id, password)
    if (old.host !== host || old.port !== server.port) {
      // 새 주소에 남은 고아 경로가 있으면 UNIQUE에 걸리므로 덮어쓴다.
      db.prepare(
        'UPDATE OR REPLACE server_recent_paths SET server_host = ?, server_port = ? WHERE server_host = ? AND server_port = ?'
      ).run(host, server.port, old.host, old.port)
    }
    return server.id
  })()

  const row = db.prepare(`SELECT ${SERVER_COLUMNS} FROM servers WHERE id = ?`).get(id) as ServerRow
  return toServer(row)
}

/**
 * 연결에 성공했다는 기록. 마지막 연결 시각을 찍는다.
 * - `id`가 있으면(저장된 서버를 저장된 계정으로 연결) 그 서버의 계정·보안 설정을 갱신하고,
 *   별칭은 비어 있지 않을 때만 바꾼다.
 * - `id`가 없는데 같은 주소의 저장된 서버가 있으면(다른 계정·익명으로 연결) 그 서버의
 *   계정은 건드리지 않고 연결 시각만 찍는다. 없으면 새 서버로 저장한다.
 * 비밀번호는 `password`대로 쓴다(저장된 비밀번호로 연결했으면 `keep`, 입력했으면 그 암호문).
 * 익명 로그인의 기본값('anonymous' / 'anonymous@')은 저장하지 않는다.
 */
export function recordConnection(
  db: Database.Database,
  payload: FtpConnectPayload,
  password: PasswordWrite
): void {
  const anonymous = /^anonymous$/i.test(payload.user.trim())
  const user = anonymous ? '' : payload.user
  const write = anonymous && payload.password === 'anonymous@' ? CLEAR_PASSWORD : password
  const name = payload.name?.trim() ?? ''
  const secure = payload.secure ? 1 : 0
  // 값이 없거나 범위 밖이면(빠른 연결) 저장된 값을 그대로 두고, 새 서버면 기본값을 쓴다.
  const maxTransfers =
    payload.maxTransfers !== undefined && isValidMaxTransfers(payload.maxTransfers)
      ? payload.maxTransfers
      : null

  db.transaction(() => {
    if (payload.id !== undefined) {
      const updated = db
        .prepare(
          `UPDATE servers SET
             name = CASE WHEN ? <> '' THEN ? ELSE name END,
             username = ?, secure = ?, max_transfers = COALESCE(?, max_transfers),
             last_connected = datetime('now')
           WHERE id = ?`
        )
        .run(name, name, user, secure, maxTransfers, payload.id)
      if (updated.changes > 0) {
        writePassword(db, payload.id, write)
        return
      }
    }
    const touched = db
      .prepare(
        "UPDATE servers SET last_connected = datetime('now') WHERE lower(host) = lower(?) AND port = ?"
      )
      .run(payload.host, payload.port)
    if (touched.changes > 0) return
    const id = db
      .prepare(
        `INSERT INTO servers (name, host, port, username, secure, max_transfers, last_connected)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        name,
        payload.host,
        payload.port,
        user,
        secure,
        maxTransfers ?? DEFAULT_MAX_TRANSFERS
      ).lastInsertRowid
    writePassword(db, Number(id), write)
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
    hasPassword: r.has_password === 1,
    secure: r.secure === 1,
    maxTransfers: r.max_transfers,
    lastConnected: r.last_connected ?? undefined
  }
}

/** 마지막 연결 순. 연결한 적 없는 서버(NULL)는 SQLite DESC 정렬에서 맨 뒤로 간다. */
export function listServers(db: Database.Database): FtpServer[] {
  const rows = db
    .prepare(`SELECT ${SERVER_COLUMNS} FROM servers ORDER BY last_connected DESC, id DESC`)
    .all() as ServerRow[]
  return rows.map(toServer)
}

export function getServerById(db: Database.Database, id: number): FtpServer | undefined {
  const row = db.prepare(`SELECT ${SERVER_COLUMNS} FROM servers WHERE id = ?`).get(id) as
    | ServerRow
    | undefined
  return row && toServer(row)
}

/** 저장된 비밀번호 컬럼 그대로. passwordVault만 읽는다. 없는 id면 undefined. */
export function getStoredPassword(
  db: Database.Database,
  id: number
): { cipher: Buffer | null; plain: string | null } | undefined {
  return db
    .prepare('SELECT password_cipher AS cipher, password_enc AS plain FROM servers WHERE id = ?')
    .get(id) as { cipher: Buffer | null; plain: string | null } | undefined
}

const loginUser = (user: string | null): string =>
  !user?.trim() || /^anonymous$/i.test(user.trim()) ? '' : user

/**
 * 이 로그인이 서버 `id`에 저장된 주소·계정과 같은지(E15). 저장된 비밀번호는 그때만 쓴다.
 * 호스트는 앞뒤 공백·대소문자를 가리지 않고, 사용자 ''와 'anonymous'(대소문자 무관)는 같은 익명이다.
 * FTPS 여부는 보지 않는다(사용자가 일부러 끌 수 있다). 없는 id면 false.
 */
export function isSavedLogin(
  db: Database.Database,
  id: number,
  login: Pick<FtpConnectPayload, 'host' | 'port' | 'user'>
): boolean {
  const row = savedAddress(db, id, login)
  return row !== undefined && loginUser(row.username) === loginUser(login.user)
}

/** 서버 `id`가 이 주소(호스트 대소문자·공백 무시, 포트)에 저장된 서버인지. 그 서버의 로그인만 갱신한다(E15). */
export function isSavedAddress(
  db: Database.Database,
  id: number,
  address: Pick<FtpConnectPayload, 'host' | 'port'>
): boolean {
  return savedAddress(db, id, address) !== undefined
}

function savedAddress(
  db: Database.Database,
  id: number,
  address: Pick<FtpConnectPayload, 'host' | 'port'>
): { username: string | null } | undefined {
  const row = db.prepare('SELECT host, port, username FROM servers WHERE id = ?').get(id) as
    | { host: string; port: number; username: string | null }
    | undefined
  return row &&
    row.host.trim().toLowerCase() === address.host.trim().toLowerCase() &&
    row.port === address.port
    ? row
    : undefined
}

/** 아직 암호화하지 않은 예전 평문 비밀번호(E4) */
export function listPlainPasswords(db: Database.Database): Array<{ id: number; plain: string }> {
  return db
    .prepare(
      "SELECT id, password_enc AS plain FROM servers WHERE IFNULL(password_enc, '') <> '' AND password_cipher IS NULL ORDER BY id"
    )
    .all() as Array<{ id: number; plain: string }>
}

/**
 * 읽은 평문이 그대로일 때만 암호문으로 바꾼다(비교 후 교체). 그사이 사용자가 바꾼 행은 덮지 않는다.
 * 바꿨으면 true.
 */
export function replacePlainPassword(
  db: Database.Database,
  id: number,
  plain: string,
  cipher: Buffer
): boolean {
  return (
    db
      .prepare(
        'UPDATE servers SET password_cipher = ?, password_enc = NULL WHERE id = ? AND password_enc = ? AND password_cipher IS NULL'
      )
      .run(cipher, id, plain).changes > 0
  )
}

/** 읽은 암호문이 그대로일 때만 새 암호문으로 바꾼다(재암호화, 비교 후 교체). 바꿨으면 true. */
export function replaceCipher(
  db: Database.Database,
  id: number,
  oldCipher: Buffer,
  newCipher: Buffer
): boolean {
  return (
    db
      .prepare('UPDATE servers SET password_cipher = ? WHERE id = ? AND password_cipher = ?')
      .run(newCipher, id, oldCipher).changes > 0
  )
}

/** 저장된 서버와 그 최근 경로를 지운다. 없는 id면 아무것도 하지 않는다. */
export function deleteServer(db: Database.Database, id: number): void {
  const row = db.prepare('SELECT host, port FROM servers WHERE id = ?').get(id) as
    | { host: string; port: number }
    | undefined
  if (row) {
    db.prepare('DELETE FROM server_recent_paths WHERE server_host = ? AND server_port = ?').run(
      row.host,
      row.port
    )
  }
  db.prepare('DELETE FROM servers WHERE id = ?').run(id)
}

/** 이 서버에서 연 폴더, 최근 순 20개. 저장된 서버처럼 호스트는 대소문자를 가리지 않는다. */
export function getRecentPaths(db: Database.Database, host: string, port: number): RecentPath[] {
  const rows = db
    .prepare(
      'SELECT path, last_visited FROM server_recent_paths WHERE lower(server_host) = lower(?) AND server_port = ? ORDER BY last_visited DESC LIMIT 20'
    )
    .all(host, port) as Array<{ path: string; last_visited: string }>
  return rows.map((r) => ({ path: r.path, lastVisited: r.last_visited }))
}
