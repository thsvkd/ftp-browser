import Database from 'better-sqlite3'
import type { RemoteFolderPreview } from '@shared/types/gallery'

interface FolderPreviewRow {
  first_image_name: string | null
  first_image_size: number | null
  first_image_modified_at: string | null
  item_count: number | null
}

/**
 * 갤러리에서 사용하는 원격 폴더 미리보기를 SQLite(`remote_folder_previews`)에 영구 캐시한다. 행은
 * 연결(host·port·사용자)마다 따로다: 같은 호스트라도 사용자마다 홈이 달라 같은 경로가 다른 폴더다(MC9).
 *
 * 반환 의미:
 * - `undefined`: 캐시 미스 — 한 번도 LIST되지 않은 폴더이므로 큐에서 처리해야 한다.
 * - `null`: 캐시 hit이지만 폴더에 표시 가능한 이미지가 없음. LIST 재발급 불필요.
 * - `RemoteFolderPreview`: 캐시 hit, 첫 이미지 메타.
 */
export class RemoteFolderPreviewCache {
  private stmtLookup: Database.Statement
  private stmtUpsert: Database.Statement
  private stmtDelete: Database.Statement
  private stmtClearByServer: Database.Statement
  private stmtClearAll: Database.Statement

  constructor(db: Database.Database) {
    this.stmtLookup = db.prepare(
      `SELECT first_image_name, first_image_size, first_image_modified_at, item_count
       FROM remote_folder_previews
       WHERE host = ? AND port = ? AND username = ? AND folder_path = ?`
    )
    this.stmtUpsert = db.prepare(
      `INSERT INTO remote_folder_previews
        (host, port, username, folder_path, first_image_name, first_image_size, first_image_modified_at, item_count, cached_at)
       VALUES (@host, @port, @username, @folderPath, @name, @size, @modifiedAt, @itemCount, datetime('now'))
       ON CONFLICT(host, port, username, folder_path) DO UPDATE SET
        first_image_name = excluded.first_image_name,
        first_image_size = excluded.first_image_size,
        first_image_modified_at = excluded.first_image_modified_at,
        item_count = excluded.item_count,
        cached_at = excluded.cached_at`
    )
    this.stmtDelete = db.prepare(
      `DELETE FROM remote_folder_previews
       WHERE host = ? AND port = ? AND username = ? AND folder_path = ?`
    )
    this.stmtClearByServer = db.prepare(
      `DELETE FROM remote_folder_previews WHERE host = ? AND port = ? AND username = ?`
    )
    this.stmtClearAll = db.prepare(`DELETE FROM remote_folder_previews`)
  }

  lookup(
    host: string,
    port: number,
    username: string,
    folderPath: string
  ): RemoteFolderPreview | null | undefined {
    const row = this.stmtLookup.get(host, port, username, folderPath) as
      | FolderPreviewRow
      | undefined
    if (!row) return undefined
    if (
      row.first_image_name === null ||
      row.first_image_size === null ||
      row.first_image_modified_at === null
    ) {
      return null
    }
    // Legacy rows cached before item_count existed have a NULL count. Treat them
    // as a cache miss so the folder is re-listed and the count is backfilled.
    if (row.item_count === null) return undefined
    return {
      name: row.first_image_name,
      size: row.first_image_size,
      modifiedAt: row.first_image_modified_at,
      itemCount: row.item_count
    }
  }

  store(
    host: string,
    port: number,
    username: string,
    folderPath: string,
    preview: RemoteFolderPreview | null
  ): void {
    this.stmtUpsert.run({
      host,
      port,
      username,
      folderPath,
      name: preview?.name ?? null,
      size: preview?.size ?? null,
      modifiedAt: preview?.modifiedAt ?? null,
      itemCount: preview?.itemCount ?? null
    })
  }

  invalidate(host: string, port: number, username: string, folderPath: string): void {
    this.stmtDelete.run(host, port, username, folderPath)
  }

  invalidateServer(host: string, port: number, username: string): void {
    this.stmtClearByServer.run(host, port, username)
  }

  clearAll(): void {
    this.stmtClearAll.run()
  }
}
