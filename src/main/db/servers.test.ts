import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { ErrorCode } from '@shared/types/ipc'
import {
  listServers,
  recordConnection,
  saveServer,
  ServerSaveError,
  type PasswordWrite
} from './servers'
import { fakeCipherOf } from './__fixtures__/fakeCipher'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  // 실제 스키마(마이그레이션 + initDatabase가 덧붙이는 인덱스·테이블)를 그대로 쓴다.
  db.exec(fs.readFileSync(path.join(__dirname, 'migrations', '001_initial.sql'), 'utf-8'))
  db.exec(
    fs.readFileSync(path.join(__dirname, 'migrations', '002_server_max_transfers.sql'), 'utf-8')
  )
  db.exec(
    fs.readFileSync(path.join(__dirname, 'migrations', '003_server_password_cipher.sql'), 'utf-8')
  )
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
  secure: false
}

const KEEP: PasswordWrite = { kind: 'keep' }
const CLEAR: PasswordWrite = { kind: 'clear' }
const plain = (password: string): PasswordWrite => ({ kind: 'plain', password })
const cipher = (password: string): PasswordWrite => ({
  kind: 'cipher',
  cipher: fakeCipherOf(password)
})

/** 저장된 비밀번호 컬럼 그대로 */
function stored(id?: number): { password_enc: string | null; password_cipher: Buffer | null } {
  return db.prepare('SELECT password_enc, password_cipher FROM servers WHERE id = ?').get(id) as {
    password_enc: string | null
    password_cipher: Buffer | null
  }
}

function paths(host: string, port: number): string[] {
  return (
    db
      .prepare('SELECT path FROM server_recent_paths WHERE server_host = ? AND server_port = ?')
      .all(host, port) as Array<{ path: string }>
  ).map((r) => r.path)
}

describe('saved password', () => {
  it('stores a cipher write as bytes, clears the legacy plain text and never returns the password', () => {
    // covers: Test-701
    const saved = saveServer(db, base, cipher('s3cret'))

    expect(stored(saved.id)).toEqual({
      password_enc: null,
      password_cipher: fakeCipherOf('s3cret')
    })
    expect(saved).toMatchObject({ hasPassword: true })
    expect(saved).not.toHaveProperty('password')
    expect(listServers(db)).toEqual([expect.objectContaining({ id: saved.id, hasPassword: true })])
    expect(listServers(db)[0]).not.toHaveProperty('password')

    // 예전 평문 행에 암호문을 쓰면 평문은 지워진다(한 행에는 둘 중 하나만)
    const legacy = Number(
      db
        .prepare(
          "INSERT INTO servers (name, host, port, username, password_enc) VALUES ('', 'old.example', 21, 'me', 'legacy-pw')"
        )
        .run().lastInsertRowid
    )
    saveServer(db, { ...base, id: legacy, host: 'old.example' }, cipher('new-pw'))
    expect(stored(legacy)).toEqual({ password_enc: null, password_cipher: fakeCipherOf('new-pw') })
  })

  it('keeps the saved cipher or legacy plain text, and clears both columns', () => {
    // covers: Test-702
    const saved = saveServer(db, base, cipher('s3cret'))
    const legacy = Number(
      db
        .prepare(
          "INSERT INTO servers (name, host, port, username, password_enc) VALUES ('', 'old.example', 21, 'me', 'legacy-pw')"
        )
        .run().lastInsertRowid
    )

    expect(saveServer(db, { ...base, id: saved.id, name: 'Renamed' }, KEEP)).toMatchObject({
      name: 'Renamed',
      hasPassword: true
    })
    expect(stored(saved.id)).toEqual({
      password_enc: null,
      password_cipher: fakeCipherOf('s3cret')
    })
    expect(saveServer(db, { ...base, id: legacy, host: 'old.example' }, KEEP).hasPassword).toBe(
      true
    )
    expect(stored(legacy)).toEqual({ password_enc: 'legacy-pw', password_cipher: null })

    expect(saveServer(db, { ...base, id: saved.id }, CLEAR).hasPassword).toBe(false)
    expect(stored(saved.id)).toEqual({ password_enc: null, password_cipher: null })
    expect(saveServer(db, { ...base, id: legacy, host: 'old.example' }, CLEAR).hasPassword).toBe(
      false
    )
    expect(stored(legacy)).toEqual({ password_enc: null, password_cipher: null })

    // 새 서버의 keep은 비밀번호 없음이다
    expect(saveServer(db, { ...base, host: 'new.example' }, KEEP).hasPassword).toBe(false)
  })
})

describe('saveServer', () => {
  it('inserts a new server without marking it connected', () => {
    const saved = saveServer(db, base, plain('pw'))

    expect(saved).toMatchObject({ ...base, id: expect.any(Number) })
    expect(saved.lastConnected).toBeUndefined()
  })

  it('refuses to create a second server on a saved address, ignoring host case', () => {
    db.prepare(
      "INSERT INTO servers (name, host, port, username, password_enc) VALUES ('Legacy', 'NAS.local', 21, 'alice', 'pw')"
    ).run()

    expect(() => saveServer(db, { ...base, name: '' }, plain('pw'))).toThrow(
      expect.objectContaining({ code: ErrorCode.SERVER_EXISTS })
    )
    // 기존 서버의 별칭·계정은 그대로다
    expect(listServers(db)).toEqual([
      expect.objectContaining({
        name: 'Legacy',
        host: 'NAS.local',
        username: 'alice',
        hasPassword: true
      })
    ])
  })

  it('lets each of two older case-only duplicate rows be edited', () => {
    db.exec(
      "INSERT INTO servers (name, host, port) VALUES ('Upper', 'NAS.local', 21), ('Lower', 'nas.local', 21)"
    )
    const [upper, lower] = listServers(db).sort((a, b) => a.id! - b.id!)

    expect(
      saveServer(db, { ...base, id: upper.id, host: 'NAS.local', name: 'U2' }, plain('pw')).name
    ).toBe('U2')
    expect(
      saveServer(db, { ...base, id: lower.id, host: 'nas.local', name: 'L2' }, plain('pw')).name
    ).toBe('L2')
  })

  it('reports a server that was deleted meanwhile and rejects out-of-range ports', () => {
    expect(() => saveServer(db, { ...base, id: 99 }, plain('pw'))).toThrow(
      expect.objectContaining({ code: ErrorCode.SERVER_NOT_FOUND })
    )
    for (const port of [0, 65536, 1.5]) {
      expect(() => saveServer(db, { ...base, port }, plain('pw'))).toThrow(
        expect.objectContaining({ code: ErrorCode.INVALID_PORT })
      )
    }
    expect(listServers(db)).toEqual([])
  })

  it('updates by id and moves recent paths when the address changes', () => {
    const { id } = saveServer(db, base, plain('pw'))
    db.prepare(
      "INSERT INTO server_recent_paths (server_host, server_port, path) VALUES ('nas.local', 21, '/photos')"
    ).run()

    const moved = saveServer(db, { ...base, id, host: 'nas2.local', port: 2121 }, plain('pw'))

    expect(moved).toMatchObject({ id, host: 'nas2.local', port: 2121 })
    expect(paths('nas2.local', 2121)).toEqual(['/photos'])
    expect(paths('nas.local', 21)).toEqual([])
    expect(listServers(db)).toHaveLength(1)
  })

  it('refuses to move a server onto another saved server', () => {
    saveServer(db, base, plain('pw'))
    const other = saveServer(db, { ...base, host: 'phone', port: 2221 }, plain('pw'))

    expect(() => saveServer(db, { ...other, host: 'NAS.LOCAL', port: 21 }, plain('pw'))).toThrow(
      ServerSaveError
    )
    expect(
      listServers(db)
        .map((s) => s.host)
        .sort()
    ).toEqual(['nas.local', 'phone'])
  })
})

describe('max transfers', () => {
  it('defaults to 16 and round-trips a saved value through save, update and list', () => {
    const saved = saveServer(db, base, plain('pw'))
    expect(saved.maxTransfers).toBe(16)

    const tuned = saveServer(db, { ...saved, maxTransfers: 4 }, plain('pw'))
    expect(tuned.maxTransfers).toBe(4)
    expect(listServers(db)).toEqual([expect.objectContaining({ id: saved.id, maxTransfers: 4 })])

    // 필드가 빠진 저장은 recordConnection처럼 저장된 값을 그대로 둔다
    expect(saveServer(db, { ...base, id: saved.id }, plain('pw')).maxTransfers).toBe(4)
  })

  it('accepts 1 and 20 and rejects anything outside 1..20 or not a whole number', () => {
    for (const maxTransfers of [1, 20]) {
      expect(
        saveServer(
          db,
          { ...base, id: undefined, host: `h${maxTransfers}`, maxTransfers },
          plain('pw')
        )
      ).toMatchObject({ maxTransfers })
    }
    for (const maxTransfers of [0, 21, -3, 2.5, NaN]) {
      expect(() => saveServer(db, { ...base, host: 'bad', maxTransfers }, plain('pw'))).toThrow(
        expect.objectContaining({ code: ErrorCode.INVALID_MAX_TRANSFERS })
      )
    }
    expect(listServers(db)).toHaveLength(2)
  })

  it('is set by a saved server connecting by id, and kept by a connect that does not send it', () => {
    const { id } = saveServer(db, { ...base, maxTransfers: 8 }, plain('pw'))
    const connectAs = { host: 'nas.local', port: 21, secure: false, user: 'me', password: 'pw' }

    recordConnection(db, { ...connectAs, id }, KEEP)
    expect(listServers(db)[0].maxTransfers).toBe(8)

    recordConnection(db, { ...connectAs, id, maxTransfers: 12 }, KEEP)
    expect(listServers(db)[0].maxTransfers).toBe(12)

    // 저장된 서버를 다른 계정으로 연결하면 그 서버의 설정은 그대로다
    recordConnection(db, { ...connectAs, user: 'bob', maxTransfers: 3 }, plain('pw'))
    expect(listServers(db)[0].maxTransfers).toBe(12)
  })

  it('gives a server first saved by connecting the sent value, or 16 for a quick connect', () => {
    const connectAs = { port: 21, secure: false, user: 'me', password: 'pw' }

    recordConnection(db, { ...connectAs, host: 'quick' }, plain('pw'))
    recordConnection(db, { ...connectAs, host: 'tuned', maxTransfers: 6 }, plain('pw'))
    recordConnection(db, { ...connectAs, host: 'garbage', maxTransfers: 99 }, plain('pw'))

    const byHost = Object.fromEntries(listServers(db).map((s) => [s.host, s.maxTransfers]))
    expect(byHost).toEqual({ quick: 16, tuned: 6, garbage: 16 })
  })
})

describe('recordConnection', () => {
  const ALICE = { ...base, username: 'alice' }
  const connectAs = { host: 'nas.local', port: 21, secure: false }
  const row = (): Record<string, unknown> =>
    db.prepare('SELECT * FROM servers').get() as Record<string, unknown>

  it('keeps the saved login when another account (or anonymous) connects to its address', () => {
    const { id } = saveServer(db, ALICE, plain('pw'))

    recordConnection(db, { ...connectAs, user: 'bob', password: 'bobpw' }, plain('bobpw'))
    recordConnection(
      db,
      { ...connectAs, host: 'NAS.LOCAL', user: 'anonymous', password: 'anonymous@' },
      plain('anonymous@')
    )

    expect(listServers(db)).toEqual([
      expect.objectContaining({ name: 'NAS', username: 'alice', hasPassword: true })
    ])
    expect(stored(id)).toEqual({ password_enc: 'pw', password_cipher: null })
    expect(row().last_connected).toBeTruthy()
  })

  it('updates the saved login and keeps the alias when the saved server connects by id', () => {
    const { id } = saveServer(db, ALICE, plain('pw'))

    recordConnection(
      db,
      { ...connectAs, id, name: '', user: 'alice', password: 'new' },
      plain('new')
    )
    expect(listServers(db)).toEqual([
      expect.objectContaining({ id, name: 'NAS', username: 'alice', hasPassword: true })
    ])
    expect(stored(id).password_enc).toBe('new')

    recordConnection(
      db,
      { ...connectAs, id, name: 'Renamed', user: 'alice', password: 'new' },
      plain('new')
    )
    expect(listServers(db)).toEqual([expect.objectContaining({ id, name: 'Renamed' })])
  })

  it('saves a new anonymous server without the default anonymous login', () => {
    recordConnection(
      db,
      { ...connectAs, user: 'anonymous', password: 'anonymous@' },
      plain('anonymous@')
    )

    expect(row()).toMatchObject({ username: '', password_enc: null, password_cipher: null })
  })

  it('keeps or replaces the saved password of the server it updates by id', () => {
    // covers: Test-703
    const { id } = saveServer(db, ALICE, cipher('old-secret'))
    const login = { ...connectAs, id, user: 'alice', password: 'old-secret' }

    // 저장된 비밀번호로 연결했으면 그대로 둔다
    recordConnection(db, login, KEEP)
    expect(stored(id)).toEqual({ password_enc: null, password_cipher: fakeCipherOf('old-secret') })

    // 입력한 비밀번호로 연결했으면 바꾼다
    recordConnection(db, { ...login, password: 'new-secret' }, cipher('new-secret'))
    expect(stored(id)).toEqual({ password_enc: null, password_cipher: fakeCipherOf('new-secret') })

    // 익명 기본값은 저장하지 않는다: 계정과 비밀번호를 비운다
    recordConnection(
      db,
      { ...login, user: 'Anonymous', password: 'anonymous@' },
      cipher('anonymous@')
    )
    expect(row()).toMatchObject({ username: '', password_enc: null, password_cipher: null })
    expect(listServers(db)[0].hasPassword).toBe(false)

    // 새 서버로 저장되는 익명 연결도 마찬가지다
    recordConnection(
      db,
      { ...connectAs, host: 'anon.example', user: 'anonymous', password: 'anonymous@' },
      cipher('anonymous@')
    )
    const anon = listServers(db).find((s) => s.host === 'anon.example')!
    expect(anon).toMatchObject({ username: '', hasPassword: false })
    expect(stored(anon.id)).toEqual({ password_enc: null, password_cipher: null })
  })
})

describe('listServers', () => {
  it('lists every server by last connection, never-connected last', () => {
    for (let i = 0; i < 25; i++) saveServer(db, { ...base, host: `h${i}` }, plain('pw'))
    db.prepare("UPDATE servers SET last_connected = '2026-09-01 00:00:00' WHERE host = 'h3'").run()

    const list = listServers(db)

    expect(list).toHaveLength(25)
    expect(list[0].host).toBe('h3')
  })
})
