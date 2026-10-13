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
CREATE INDEX IF NOT EXISTS idx_remote_folder_previews_conn ON remote_folder_previews(host, port, username);
