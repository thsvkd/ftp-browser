CREATE TABLE IF NOT EXISTS remote_recent_paths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL,
  path TEXT NOT NULL,
  last_visited TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(host, port, username, path)
);
CREATE INDEX IF NOT EXISTS idx_remote_recent_paths_conn ON remote_recent_paths(host, port, username);
