CREATE TABLE IF NOT EXISTS thumbnails (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key        TEXT NOT NULL UNIQUE,
    host             TEXT NOT NULL,
    port             INTEGER NOT NULL,
    remote_path      TEXT NOT NULL,
    file_size        INTEGER NOT NULL,
    modified_at      TEXT NOT NULL,
    thumbnail_path   TEXT NOT NULL,
    width            INTEGER NOT NULL,
    height           INTEGER NOT NULL,
    original_format  TEXT NOT NULL,
    byte_size        INTEGER NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    last_accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_thumb_cache_key ON thumbnails(cache_key);
CREATE INDEX IF NOT EXISTS idx_thumb_last_accessed ON thumbnails(last_accessed_at);

CREATE TABLE IF NOT EXISTS servers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    host            TEXT NOT NULL,
    port            INTEGER NOT NULL DEFAULT 21,
    username        TEXT,
    password_enc    TEXT,
    secure          INTEGER NOT NULL DEFAULT 0,
    last_connected  TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
