import Database from 'better-sqlite3'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import { MAX_CACHE_SIZE_BYTES } from '@shared/constants'

export interface CacheEntry {
  id: number
  cache_key: string
  thumbnail_path: string
  width: number
  height: number
  byte_size: number
}

export interface CacheInsertPayload {
  cacheKey: string
  host: string
  port: number
  remotePath: string
  fileSize: number
  modifiedAt: string
  width: number
  height: number
  originalFormat: string
  thumbnailBuffer: Buffer
}

export interface CacheStats {
  totalBytes: number
  totalCount: number
}

export class CacheManager {
  private cacheDir: string
  private stmtLookup: Database.Statement
  private stmtInsert: Database.Statement
  private stmtUpdateAccess: Database.Statement
  private stmtEvictQuery: Database.Statement
  private stmtDeleteById: Database.Statement
  private stmtTotalSize: Database.Statement
  private stmtClearAll: Database.Statement

  constructor(db: Database.Database) {
    this.cacheDir = path.join(app.getPath('userData'), 'thumbnails')
    fs.mkdirSync(this.cacheDir, { recursive: true })

    this.stmtLookup = db.prepare(
      'SELECT id, cache_key, thumbnail_path, width, height, byte_size FROM thumbnails WHERE cache_key = ?'
    )
    this.stmtInsert = db.prepare(`
      INSERT OR REPLACE INTO thumbnails
        (cache_key, host, port, remote_path, file_size, modified_at, thumbnail_path, width, height, original_format, byte_size)
      VALUES
        (@cacheKey, @host, @port, @remotePath, @fileSize, @modifiedAt, @thumbnailPath, @width, @height, @originalFormat, @byteSize)
    `)
    this.stmtUpdateAccess = db.prepare(
      "UPDATE thumbnails SET last_accessed_at = datetime('now') WHERE cache_key = ?"
    )
    this.stmtEvictQuery = db.prepare(
      'SELECT id, thumbnail_path, byte_size FROM thumbnails ORDER BY last_accessed_at ASC LIMIT ?'
    )
    this.stmtDeleteById = db.prepare('DELETE FROM thumbnails WHERE id = ?')
    this.stmtTotalSize = db.prepare(
      'SELECT COALESCE(SUM(byte_size), 0) as total, COUNT(*) as count FROM thumbnails'
    )
    this.stmtClearAll = db.prepare('DELETE FROM thumbnails')
  }

  /** DB의 forward-slash 상대경로를 OS 네이티브 경로로 변환 */
  private toNativePath(dbRelPath: string): string {
    return path.join(this.cacheDir, ...dbRelPath.split('/'))
  }

  lookup(cacheKey: string): CacheEntry | null {
    const row = this.stmtLookup.get(cacheKey) as CacheEntry | undefined
    if (row) {
      // Check if file still exists on disk
      const fullPath = this.toNativePath(row.thumbnail_path)
      if (fs.existsSync(fullPath)) {
        this.stmtUpdateAccess.run(cacheKey)
        return row
      }
      // File missing, delete the row
      this.stmtDeleteById.run(row.id)
    }
    return null
  }

  readThumbnail(entry: CacheEntry): Buffer {
    return fs.readFileSync(this.toNativePath(entry.thumbnail_path))
  }

  store(payload: CacheInsertPayload): void {
    // 캐시 키를 해시하여 파일시스템에 안전한 파일명 생성
    const hash = crypto.createHash('sha256').update(payload.cacheKey).digest('hex')
    const subDir = hash.substring(0, 2)
    const dirPath = path.join(this.cacheDir, subDir)
    fs.mkdirSync(dirPath, { recursive: true })

    // DB에는 항상 forward slash로 저장 (크로스 플랫폼 일관성)
    const relativePath = `${subDir}/${hash}.jpg`
    fs.writeFileSync(this.toNativePath(relativePath), payload.thumbnailBuffer)

    this.stmtInsert.run({
      cacheKey: payload.cacheKey,
      host: payload.host,
      port: payload.port,
      remotePath: payload.remotePath,
      fileSize: payload.fileSize,
      modifiedAt: payload.modifiedAt,
      thumbnailPath: relativePath,
      width: payload.width,
      height: payload.height,
      originalFormat: payload.originalFormat,
      byteSize: payload.thumbnailBuffer.length
    })

    this.evictIfNeeded()
  }

  getStats(): CacheStats {
    const row = this.stmtTotalSize.get() as { total: number; count: number }
    return { totalBytes: row.total, totalCount: row.count }
  }

  clearAll(): void {
    // Delete all thumbnail files
    fs.rmSync(this.cacheDir, { recursive: true, force: true })
    fs.mkdirSync(this.cacheDir, { recursive: true })
    this.stmtClearAll.run()
  }

  private evictIfNeeded(): void {
    const { totalBytes } = this.getStats()
    if (totalBytes <= MAX_CACHE_SIZE_BYTES) return

    const targetSize = MAX_CACHE_SIZE_BYTES * 0.8
    let freed = 0
    const toFree = totalBytes - targetSize

    // Get oldest entries
    const rows = this.stmtEvictQuery.all(100) as Array<{
      id: number
      thumbnail_path: string
      byte_size: number
    }>

    for (const row of rows) {
      if (freed >= toFree) break

      // Delete file
      try {
        fs.unlinkSync(this.toNativePath(row.thumbnail_path))
      } catch {
        // File already gone
      }

      this.stmtDeleteById.run(row.id)
      freed += row.byte_size
    }
  }
}
