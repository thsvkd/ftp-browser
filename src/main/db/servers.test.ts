import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { ErrorCode } from '@shared/types/ipc'
import {
  deleteServer,
  getRecentPaths,
  listServers,
  recordConnection,
  recordRecentPath,
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
  db.exec(
    fs.readFileSync(path.join(__dirname, 'migrations', '005_remote_recent_paths.sql'), 'utf-8')
  )
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

/** 그 host·port의 최근 경로 행, 사용자마다 `user path` */
function paths(host: string, port: number): string[] {
  return (
    db
      .prepare(
        'SELECT username, path FROM remote_recent_paths WHERE host = ? AND port = ? ORDER BY username, path'
      )
      .all(host, port) as Array<{ username: string; path: string }>
  ).map((r) => `${r.username} ${r.path}`)
}

function addPath(host: string, port: number, username: string, path: string): void {
  db.prepare(
    'INSERT INTO remote_recent_paths (host, port, username, path) VALUES (?, ?, ?, ?)'
  ).run(host, port, username, path)
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
    addPath('nas.local', 21, 'me', '/photos')

    const moved = saveServer(db, { ...base, id, host: 'nas2.local', port: 2121 }, plain('pw'))

    expect(moved).toMatchObject({ id, host: 'nas2.local', port: 2121 })
    expect(paths('nas2.local', 2121)).toEqual(['me /photos'])
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

describe('recent paths per connection', () => {
  const RA = 'ra@127.0.0.1:2121'
  const RB2 = 'rb2@127.0.0.1:2121'
  const read = (key: string): string[] => getRecentPaths(db, key).map((p) => p.path)
  /** 밀리초 시각이 바뀔 때까지 기다린다(기록 순서가 시각으로 갈리게) */
  const nextMs = (): void => {
    const start = Date.now()
    while (Date.now() < start + 2) {
      // 바쁜 대기
    }
  }

  it('records and reads the recent folders of each user@host:port on its own', () => {
    // covers: Test-1148
    recordRecentPath(db, RA, '/photos')
    recordRecentPath(db, RB2, '/inbox')
    expect(read(RB2)).toEqual(['/inbox'])
    expect(read(RA)).toEqual(['/photos'])

    // 호스트는 대소문자를 가리지 않고, 사용자는 가린다
    recordRecentPath(db, 'me@nas.local:21', '/a')
    expect(read('me@NAS.local:21')).toEqual(['/a'])
    expect(read('ME@nas.local:21')).toEqual([])

    // 같은 경로를 다시 기록하면 행이 늘지 않고 맨 앞으로
    recordRecentPath(db, 'me@nas.local:21', '/b')
    db.prepare("UPDATE remote_recent_paths SET last_visited = '2000-01-01 00:00:00.000'").run()
    recordRecentPath(db, 'me@nas.local:21', '/a')
    expect(read('me@nas.local:21')).toEqual(['/a', '/b'])
    expect(paths('nas.local', 21)).toEqual(['me /a', 'me /b'])

    // 호스트 철자만 다르게 같은 경로를 기록해도 행이 늘지 않고, 20개도 한 키로 센다
    nextMs()
    recordRecentPath(db, 'me@NAS.local:21', '/b')
    expect(read('me@nas.local:21')).toEqual(['/b', '/a'])
    expect(paths('NAS.local', 21)).toEqual(['me /b'])
    expect(paths('nas.local', 21)).toEqual(['me /a'])
    for (let i = 0; i <= 20; i++) {
      nextMs()
      recordRecentPath(db, i < 20 ? 'me@NAS.local:21' : 'me@nas.local:21', `/c${i}`)
    }
    expect(read('me@nas.local:21')).toEqual(Array.from({ length: 20 }, (_, i) => `/c${20 - i}`))
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM remote_recent_paths WHERE lower(host) = 'nas.local'")
        .get()
    ).toEqual({ n: 20 })

    // 키마다 20개를 남긴다
    const many = Array.from({ length: 25 }, (_, i) => `/p${i}`)
    for (const p of many) {
      nextMs()
      recordRecentPath(db, RA, p)
    }
    expect(read(RA)).toEqual(many.slice(5).reverse())
    // 시계 분해능이 거친 OS(Windows ~15ms)에서는 시각이 같을 수 있다: 그때는 나중에 넣은 행이 앞
    db.prepare(
      "UPDATE remote_recent_paths SET last_visited = '2026-01-01 00:00:00.000' WHERE username = 'ra'"
    ).run()
    expect(read(RA)).toEqual(many.slice(5).reverse())
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM remote_recent_paths WHERE username = 'ra'").get()
    ).toEqual({ n: 20 })
    expect(read(RB2)).toEqual(['/inbox'])
  })

  it("moves every user's recent folders with the saved address and deletes them with the server", () => {
    // covers: Test-1149
    const { id } = saveServer(db, base, plain('pw'))
    addPath('nas.local', 21, 'me', '/photos')
    addPath('nas.local', 21, 'guest', '/guest')
    // 옛 테이블에서 호스트 철자 그대로 복사된 행(SH9)도 저장 행을 따라간다
    addPath('NAS.local', 21, 'me', '/old-case')
    // 새 주소에 같은 사용자·경로의 행이 이미 있어도 실패하지 않는다
    addPath('nas.local', 2121, 'me', '/photos')

    saveServer(db, { ...base, id, port: 2121 }, plain('pw'))
    expect(paths('nas.local', 2121)).toEqual(['guest /guest', 'me /old-case', 'me /photos'])
    expect(paths('nas.local', 21)).toEqual([])
    expect(paths('NAS.local', 21)).toEqual([])

    // 사용자만 바꾸면 아무 행도 옮기지 않는다
    saveServer(db, { ...base, id, port: 2121, username: 'you' }, plain('pw'))
    expect(paths('nas.local', 2121)).toEqual(['guest /guest', 'me /old-case', 'me /photos'])

    // 지우면 그 host·port의 모든 사용자 행(호스트 철자만 다른 행 포함)과 옛 테이블 행이 지워지고,
    // 다른 주소의 행은 남는다
    addPath('other.lan', 21, 'me', '/keep')
    addPath('NAS.local', 2121, 'me', '/photos')
    db.prepare(
      "INSERT INTO server_recent_paths (server_host, server_port, path) VALUES ('nas.local', 2121, '/old')"
    ).run()
    deleteServer(db, id!)
    expect(paths('nas.local', 2121)).toEqual([])
    expect(paths('NAS.local', 2121)).toEqual([])
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM server_recent_paths WHERE server_host = 'nas.local'")
        .get()
    ).toEqual({ n: 0 })
    expect(paths('other.lan', 21)).toEqual(['me /keep'])
  })
})
