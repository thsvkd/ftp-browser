import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { ErrorCode } from '@shared/types/ipc'
import { listServers, recordConnection, saveServer, ServerSaveError } from './servers'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  // 실제 스키마(마이그레이션 + initDatabase가 덧붙이는 인덱스·테이블)를 그대로 쓴다.
  db.exec(fs.readFileSync(path.join(__dirname, 'migrations', '001_initial.sql'), 'utf-8'))
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_host_port ON servers(host, port)')
  db.exec(`CREATE TABLE IF NOT EXISTS server_recent_paths (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_host TEXT NOT NULL,
    server_port INTEGER NOT NULL,
    path TEXT NOT NULL,
    last_visited TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(server_host, server_port, path)
  )`)
})

afterEach(() => db.close())

const base = {
  name: 'NAS',
  host: 'nas.local',
  port: 21,
  username: 'me',
  password: 'pw',
  secure: false
}

function paths(host: string, port: number): string[] {
  return (
    db
      .prepare('SELECT path FROM server_recent_paths WHERE server_host = ? AND server_port = ?')
      .all(host, port) as Array<{ path: string }>
  ).map((r) => r.path)
}

describe('saveServer', () => {
  it('inserts a new server without marking it connected', () => {
    const saved = saveServer(db, base)

    expect(saved).toMatchObject({ ...base, id: expect.any(Number) })
    expect(saved.lastConnected).toBeUndefined()
  })

  it('refuses to create a second server on a saved address, ignoring host case', () => {
    db.prepare(
      "INSERT INTO servers (name, host, port, username, password_enc) VALUES ('Legacy', 'NAS.local', 21, 'alice', 'pw')"
    ).run()

    expect(() => saveServer(db, { ...base, name: '' })).toThrow(
      expect.objectContaining({ code: ErrorCode.SERVER_EXISTS })
    )
    // 기존 서버의 별칭·계정은 그대로다
    expect(listServers(db)).toEqual([
      expect.objectContaining({
        name: 'Legacy',
        host: 'NAS.local',
        username: 'alice',
        password: 'pw'
      })
    ])
  })

  it('lets each of two older case-only duplicate rows be edited', () => {
    db.exec(
      "INSERT INTO servers (name, host, port) VALUES ('Upper', 'NAS.local', 21), ('Lower', 'nas.local', 21)"
    )
    const [upper, lower] = listServers(db).sort((a, b) => a.id! - b.id!)

    expect(saveServer(db, { ...base, id: upper.id, host: 'NAS.local', name: 'U2' }).name).toBe('U2')
    expect(saveServer(db, { ...base, id: lower.id, host: 'nas.local', name: 'L2' }).name).toBe('L2')
  })

  it('reports a server that was deleted meanwhile and rejects out-of-range ports', () => {
    expect(() => saveServer(db, { ...base, id: 99 })).toThrow(
      expect.objectContaining({ code: ErrorCode.SERVER_NOT_FOUND })
    )
    for (const port of [0, 65536, 1.5]) {
      expect(() => saveServer(db, { ...base, port })).toThrow(
        expect.objectContaining({ code: ErrorCode.INVALID_PORT })
      )
    }
    expect(listServers(db)).toEqual([])
  })

  it('updates by id and moves recent paths when the address changes', () => {
    const { id } = saveServer(db, base)
    db.prepare(
      "INSERT INTO server_recent_paths (server_host, server_port, path) VALUES ('nas.local', 21, '/photos')"
    ).run()

    const moved = saveServer(db, { ...base, id, host: 'nas2.local', port: 2121 })

    expect(moved).toMatchObject({ id, host: 'nas2.local', port: 2121 })
    expect(paths('nas2.local', 2121)).toEqual(['/photos'])
    expect(paths('nas.local', 21)).toEqual([])
    expect(listServers(db)).toHaveLength(1)
  })

  it('refuses to move a server onto another saved server', () => {
    saveServer(db, base)
    const other = saveServer(db, { ...base, host: 'phone', port: 2221 })

    expect(() => saveServer(db, { ...other, host: 'NAS.LOCAL', port: 21 })).toThrow(ServerSaveError)
    expect(
      listServers(db)
        .map((s) => s.host)
        .sort()
    ).toEqual(['nas.local', 'phone'])
  })
})

describe('recordConnection', () => {
  const ALICE = { ...base, username: 'alice', password: 'pw' }
  const connectAs = { host: 'nas.local', port: 21, secure: false }
  const row = (): Record<string, unknown> =>
    db.prepare('SELECT * FROM servers').get() as Record<string, unknown>

  it('keeps the saved login when another account (or anonymous) connects to its address', () => {
    saveServer(db, ALICE)

    recordConnection(db, { ...connectAs, user: 'bob', password: 'bobpw' })
    recordConnection(db, {
      ...connectAs,
      host: 'NAS.LOCAL',
      user: 'anonymous',
      password: 'anonymous@'
    })

    expect(listServers(db)).toEqual([
      expect.objectContaining({ name: 'NAS', username: 'alice', password: 'pw' })
    ])
    expect(row().last_connected).toBeTruthy()
  })

  it('updates the saved login and keeps the alias when the saved server connects by id', () => {
    const { id } = saveServer(db, ALICE)

    recordConnection(db, { ...connectAs, id, name: '', user: 'alice', password: 'new' })
    expect(listServers(db)).toEqual([
      expect.objectContaining({ id, name: 'NAS', username: 'alice', password: 'new' })
    ])

    recordConnection(db, { ...connectAs, id, name: 'Renamed', user: 'alice', password: 'new' })
    expect(listServers(db)).toEqual([expect.objectContaining({ id, name: 'Renamed' })])
  })

  it('saves a new anonymous server without the default anonymous login', () => {
    recordConnection(db, { ...connectAs, user: 'anonymous', password: 'anonymous@' })

    expect(row()).toMatchObject({ username: '', password_enc: '' })
  })
})

describe('listServers', () => {
  it('lists every server by last connection, never-connected last', () => {
    for (let i = 0; i < 25; i++) saveServer(db, { ...base, host: `h${i}` })
    db.prepare("UPDATE servers SET last_connected = '2026-09-01 00:00:00' WHERE host = 'h3'").run()

    const list = listServers(db)

    expect(list).toHaveLength(25)
    expect(list[0].host).toBe('h3')
  })
})
