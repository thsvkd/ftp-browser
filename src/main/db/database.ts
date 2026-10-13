import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'

let db: Database.Database | null = null

export function initDatabase(): Database.Database {
  if (db) return db

  const dbPath = path.join(app.getPath('userData'), 'cache.db')
  db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // 지우거나 바꾼 행이 페이지에 남긴 바이트를 0으로 덮는다. 평문 비밀번호를 암호문으로 바꾼 뒤
  // 옛 값이 파일에 남지 않게 한다(docs/handoff/saved-password-encryption.md Test-717).
  db.pragma('secure_delete = FAST')

  // Run migrations
  const migrationPath = path.join(__dirname, 'migrations', '001_initial.sql')
  // In production, the file is bundled; in dev, read from source
  let sql: string
  try {
    sql = fs.readFileSync(migrationPath, 'utf-8')
  } catch {
    // Fallback: inline migration
    sql = `
      CREATE TABLE IF NOT EXISTS thumbnails (
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
      CREATE INDEX IF NOT EXISTS idx_thumb_cache_key ON thumbnails(cache_key);
      CREATE INDEX IF NOT EXISTS idx_thumb_last_accessed ON thumbnails(last_accessed_at);
      CREATE TABLE IF NOT EXISTS servers (
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
      CREATE TABLE IF NOT EXISTS server_recent_paths (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_host TEXT NOT NULL,
        server_port INTEGER NOT NULL,
        path TEXT NOT NULL,
        last_visited TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(server_host, server_port, path)
      );
      CREATE TABLE IF NOT EXISTS preview_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cache_key TEXT NOT NULL UNIQUE,
        file_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS folder_previews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        folder_path TEXT NOT NULL,
        first_image_name TEXT,
        first_image_size INTEGER,
        first_image_modified_at TEXT,
        item_count INTEGER,
        cached_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(host, port, folder_path)
      );
      CREATE INDEX IF NOT EXISTS idx_folder_previews_host_port ON folder_previews(host, port);
    `
  }

  db.exec(sql)

  // Additional migrations for existing DBs
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_host_port ON servers(host, port)')
  } catch {
    // already exists
  }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS server_recent_paths (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_host TEXT NOT NULL,
      server_port INTEGER NOT NULL,
      path TEXT NOT NULL,
      last_visited TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(server_host, server_port, path)
    )`)
  } catch {
    // already exists
  }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS preview_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_key TEXT NOT NULL UNIQUE,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
  } catch {
    // already exists
  }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS folder_previews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      folder_path TEXT NOT NULL,
      first_image_name TEXT,
      first_image_size INTEGER,
      first_image_modified_at TEXT,
      item_count INTEGER,
      cached_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(host, port, folder_path)
    )`)
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_folder_previews_host_port ON folder_previews(host, port)'
    )
  } catch {
    // already exists
  }
  // Add item_count to folder_previews tables created before this column existed.
  // "duplicate column name" is expected (column already present); anything else
  // is a real problem and must not be swallowed silently.
  try {
    db.exec('ALTER TABLE folder_previews ADD COLUMN item_count INTEGER')
  } catch (err) {
    if (!String(err).includes('duplicate column name')) {
      console.warn('[database] Failed to add folder_previews.item_count column:', err)
    }
  }

  // 002: 서버별 동시 전송 수. 기존 행은 컬럼 기본값 16을 받는다. ALTER는 두 번 실행할 수 없으므로
  // "duplicate column name"은 이미 적용된 것으로 본다.
  let serverMaxTransfersSql: string
  try {
    serverMaxTransfersSql = fs.readFileSync(
      path.join(__dirname, 'migrations', '002_server_max_transfers.sql'),
      'utf-8'
    )
  } catch {
    serverMaxTransfersSql =
      'ALTER TABLE servers ADD COLUMN max_transfers INTEGER NOT NULL DEFAULT 16'
  }
  try {
    db.exec(serverMaxTransfersSql)
  } catch (err) {
    // item_count 캐시와 달리 이 컬럼이 없으면 서버 목록을 읽지 못하므로 에러로 남긴다
    if (!String(err).includes('duplicate column name')) {
      console.error('[database] Failed to add servers.max_transfers column:', err)
    }
  }

  // 003: 저장된 비밀번호의 암호문(safeStorage). password_enc는 예전 평문 전용으로 남고, 평문은
  // 시작할 때 passwordVault.migrate가 옮긴다. 새 DB도 001의 CREATE TABLE 뒤에 이 ALTER로 컬럼을 얻는다.
  let serverPasswordCipherSql: string
  try {
    serverPasswordCipherSql = fs.readFileSync(
      path.join(__dirname, 'migrations', '003_server_password_cipher.sql'),
      'utf-8'
    )
  } catch {
    serverPasswordCipherSql = 'ALTER TABLE servers ADD COLUMN password_cipher BLOB'
  }
  try {
    db.exec(serverPasswordCipherSql)
  } catch (err) {
    // 이 컬럼이 없으면 서버 목록을 읽지 못하므로 에러로 남긴다
    if (!String(err).includes('duplicate column name')) {
      console.error('[database] Failed to add servers.password_cipher column:', err)
    }
  }

  // 004: 사용자별 원격 폴더 미리보기(multi-connection MC9). folder_previews의 UNIQUE(host, port,
  // folder_path)는 바꿀 수 없어 새 테이블을 쓴다. 옛 테이블과 그 행은 지우지 않는다(쓰지 않을 뿐).
  let remoteFolderPreviewsSql: string
  try {
    remoteFolderPreviewsSql = fs.readFileSync(
      path.join(__dirname, 'migrations', '004_remote_folder_previews.sql'),
      'utf-8'
    )
  } catch {
    remoteFolderPreviewsSql = `
      CREATE TABLE IF NOT EXISTS remote_folder_previews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        folder_path TEXT NOT NULL,
        first_image_name TEXT,
        first_image_size INTEGER,
        first_image_modified_at TEXT,
        item_count INTEGER,
        cached_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(host, port, username, folder_path)
      );
      CREATE INDEX IF NOT EXISTS idx_remote_folder_previews_conn
        ON remote_folder_previews(host, port, username);
    `
  }
  db.exec(remoteFolderPreviewsSql)

  migrateRemoteRecentPaths(db)

  return db
}

/**
 * 005: 연결 키(host·port·사용자)마다 최근 경로(same-host-accounts SH8). server_recent_paths의
 * UNIQUE(server_host, server_port, path)는 바꿀 수 없어 새 테이블을 쓴다. 옛 테이블과 행은 지우지 않는다
 * (더 읽지 않을 뿐).
 */
function migrateRemoteRecentPaths(database: Database.Database): void {
  let remoteRecentPathsSql: string
  try {
    remoteRecentPathsSql = fs.readFileSync(
      path.join(__dirname, 'migrations', '005_remote_recent_paths.sql'),
      'utf-8'
    )
  } catch {
    remoteRecentPathsSql = `
      CREATE TABLE IF NOT EXISTS remote_recent_paths (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        path TEXT NOT NULL,
        last_visited TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(host, port, username, path)
      );
      CREATE INDEX IF NOT EXISTS idx_remote_recent_paths_conn
        ON remote_recent_paths(host, port, username);
    `
  }
  // 테이블이 처음 생길 때 한 번만, 옛 행을 같은 host·port 저장 행의 사용자(익명은 키처럼
  // 'anonymous')로 옮긴다(SH9). 매번 돌리면 서버를 지워 없앤 경로나 계정을 바꾸기 전의 경로가
  // 옛 테이블에서 되살아난다. 생성과 복사를 한 트랜잭션으로 묶어, 중간에 꺼지면 다음 시작에 다시 한다.
  const existed = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'remote_recent_paths'")
    .get()
  database.transaction(() => {
    database.exec(remoteRecentPathsSql)
    if (existed) return
    database.exec(`
      INSERT OR IGNORE INTO remote_recent_paths (host, port, username, path, last_visited)
        SELECT p.server_host, p.server_port, COALESCE(NULLIF(s.username, ''), 'anonymous'),
               p.path, p.last_visited
        FROM server_recent_paths p
        JOIN servers s ON lower(s.host) = lower(p.server_host) AND s.port = p.server_port
    `)
  })()
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}
