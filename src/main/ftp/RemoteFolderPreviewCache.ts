import Database from 'better-sqlite3'
import type { RemoteFolderPreview } from '@shared/types/gallery'

interface FolderPreviewRow {
  first_image_name: string | null
  first_image_size: number | null
  first_image_modified_at: string | null
  item_count: number | null
}

/**
 * 갤러리에서 사용하는 원격 폴더 미리보기를 SQLite에 영구 캐시한다.
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
       FROM folder_previews
       WHERE host = ? AND port = ? AND folder_path = ?`
    )
    this.stmtUpsert = db.prepare(
      `INSERT INTO folder_previews
        (host, port, folder_path, first_image_name, first_image_size, first_image_modified_at, item_count, cached_at)
       VALUES (@host, @port, @folderPath, @name, @size, @modifiedAt, @itemCount, datetime('now'))
       ON CONFLICT(host, port, folder_path) DO UPDATE SET
        first_image_name = excluded.first_image_name,
        first_image_size = excluded.first_image_size,
        first_image_modified_at = excluded.first_image_modified_at,
        item_count = excluded.item_count,
        cached_at = excluded.cached_at`
    )
    this.stmtDelete = db.prepare(
      `DELETE FROM folder_previews WHERE host = ? AND port = ? AND folder_path = ?`
    )
    this.stmtClearByServer = db.prepare(`DELETE FROM folder_previews WHERE host = ? AND port = ?`)
    this.stmtClearAll = db.prepare(`DELETE FROM folder_previews`)
  }

  lookup(host: string, port: number, folderPath: string): RemoteFolderPreview | null | undefined {
    const row = this.stmtLookup.get(host, port, folderPath) as FolderPreviewRow | undefined
    if (!row) return undefined
    if (
      row.first_image_name === null ||
      row.first_image_size === null ||
      row.first_image_modified_at === null
    ) {
      return null
    }
    return {
      name: row.first_image_name,
      size: row.first_image_size,
      modifiedAt: row.first_image_modified_at,
      itemCount: row.item_count ?? 0
    }
  }

  store(host: string, port: number, folderPath: string, preview: RemoteFolderPreview | null): void {
    this.stmtUpsert.run({
      host,
      port,
      folderPath,
      name: preview?.name ?? null,
      size: preview?.size ?? null,
      modifiedAt: preview?.modifiedAt ?? null,
      itemCount: preview?.itemCount ?? null
    })
  }

  invalidate(host: string, port: number, folderPath: string): void {
    this.stmtDelete.run(host, port, folderPath)
  }

  invalidateServer(host: string, port: number): void {
    this.stmtClearByServer.run(host, port)
  }

  clearAll(): void {
    this.stmtClearAll.run()
  }
}
