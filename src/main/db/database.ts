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

  return db
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}
