import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn()
  }
}))

function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function readDatabaseSource(): string {
  return fs.readFileSync(path.join(process.cwd(), 'src/main/db/database.ts'), 'utf8')
}

describe('installed better-sqlite3 API', () => {
  it('should run pragma, exec, prepare/run and prepare/get without throwing', () => {
    // covers: Test-195
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftp-browser-sqlite-api-'))
    const dbPath = path.join(dir, 'api.db')
    const db = new Database(dbPath)
    try {
      db.pragma('journal_mode = WAL')
      db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
      db.prepare('INSERT INTO items (name) VALUES (?)').run('runtime-stack')
      const row = db.prepare('SELECT name FROM items WHERE name = ?').get('runtime-stack')
      expect(row).toEqual({ name: 'runtime-stack' })
    } finally {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('initDatabase cache.db', () => {
  let userData: string
  let opened: Database.Database | undefined

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ftp-browser-cache-'))
    vi.resetModules()
  })

  afterEach(() => {
    try {
      opened?.close()
    } catch {
      // already closed
    }
    opened = undefined
    fs.rmSync(userData, { recursive: true, force: true })
  })

  async function loadInitDatabase(): Promise<typeof import('./database').initDatabase> {
    const { app } = await import('electron')
    vi.mocked(app.getPath).mockImplementation(((name: string) => {
      if (name !== 'userData') throw new Error(`unexpected getPath: ${name}`)
      return userData
    }) as typeof app.getPath)
    const { initDatabase } = await import('./database')
    return initDatabase
  }

  it('should open userData/cache.db from initDatabase without deleting it', async () => {
    // covers: Test-196
    const source = stripTsComments(readDatabaseSource())
    expect(source).toMatch(
      /path\.join\(\s*app\.getPath\(\s*['"]userData['"]\s*\)\s*,\s*['"]cache\.db['"]\s*\)/
    )
    expect(source).not.toMatch(/\b(?:unlink|unlinkSync|rm|rmSync)\s*\(/)

    const cachePath = path.join(userData, 'cache.db')
    const seed = new Database(cachePath)
    seed.exec('CREATE TABLE keep_me (id INTEGER PRIMARY KEY)')
    seed.close()

    const initDatabase = await loadInitDatabase()
    opened = initDatabase()

    expect(opened.name).toBe(cachePath)
    expect(fs.existsSync(cachePath)).toBe(true)
  })

  it('should keep existing servers and thumbnails rows when initDatabase opens cache.db', async () => {
    // covers: Test-197
    const cachePath = path.join(userData, 'cache.db')
    const seed = new Database(cachePath)
    seed.exec(`
      CREATE TABLE thumbnails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cache_key TEXT NOT NULL UNIQUE,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        remote_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        thumbnail_path TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        original_format TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 21,
        username TEXT,
        password_enc TEXT,
        secure INTEGER NOT NULL DEFAULT 0,
        last_connected TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    seed
      .prepare('INSERT INTO servers (name, host, port) VALUES (?, ?, ?)')
      .run('seed-server-test-197', 'seed.ftp.test', 2121)
    seed
      .prepare(
        `INSERT INTO thumbnails (
          cache_key, host, port, remote_path, file_size, modified_at,
          thumbnail_path, width, height, original_format, byte_size
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'seed-thumb-test-197',
        'seed.ftp.test',
        2121,
        '/seed.jpg',
        1024,
        '2024-01-01T00:00:00Z',
        '/tmp/seed-thumb.jpg',
        64,
        64,
        'jpeg',
        128
      )
    seed.close()

    const initDatabase = await loadInitDatabase()
    opened = initDatabase()

    const tables = opened
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('servers', 'thumbnails')
         ORDER BY name`
      )
      .all() as { name: string }[]
    expect(tables).toEqual([{ name: 'servers' }, { name: 'thumbnails' }])

    expect(
      opened
        .prepare('SELECT name, host, port FROM servers WHERE name = ?')
        .get('seed-server-test-197')
    ).toEqual({ name: 'seed-server-test-197', host: 'seed.ftp.test', port: 2121 })
    expect(
      opened
        .prepare('SELECT cache_key, host FROM thumbnails WHERE cache_key = ?')
        .get('seed-thumb-test-197')
    ).toEqual({ cache_key: 'seed-thumb-test-197', host: 'seed.ftp.test' })
  })
})
