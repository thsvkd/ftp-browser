import Database from 'better-sqlite3'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import { MAX_PREVIEW_CACHE_SIZE_BYTES } from '@shared/constants'

interface PreviewCacheEntry {
  id: number
  cache_key: string
  file_path: string
  mime_type: string
  byte_size: number
}

export class PreviewCacheManager {
  private cacheDir: string
  private stmtLookup: Database.Statement
  private stmtInsert: Database.Statement
  private stmtUpdateAccess: Database.Statement
  private stmtEvictQuery: Database.Statement
  private stmtDeleteById: Database.Statement
  private stmtTotalSize: Database.Statement

  constructor(db: Database.Database) {
    this.cacheDir = path.join(app.getPath('userData'), 'preview_cache')
    fs.mkdirSync(this.cacheDir, { recursive: true })

    this.stmtLookup = db.prepare(
      'SELECT id, cache_key, file_path, mime_type, byte_size FROM preview_cache WHERE cache_key = ?'
    )
    this.stmtInsert = db.prepare(`
      INSERT OR REPLACE INTO preview_cache
        (cache_key, file_path, mime_type, byte_size)
      VALUES
        (@cacheKey, @filePath, @mimeType, @byteSize)
    `)
    this.stmtUpdateAccess = db.prepare(
      "UPDATE preview_cache SET last_accessed_at = datetime('now') WHERE cache_key = ?"
    )
    this.stmtEvictQuery = db.prepare(
      'SELECT id, file_path, byte_size FROM preview_cache ORDER BY last_accessed_at ASC LIMIT ?'
    )
    this.stmtDeleteById = db.prepare('DELETE FROM preview_cache WHERE id = ?')
    this.stmtTotalSize = db.prepare(
      'SELECT COALESCE(SUM(byte_size), 0) as total FROM preview_cache'
    )
  }

  private toNativePath(dbRelPath: string): string {
    return path.join(this.cacheDir, ...dbRelPath.split('/'))
  }

  lookup(cacheKey: string): { filePath: string; mimeType: string } | null {
    const row = this.stmtLookup.get(cacheKey) as PreviewCacheEntry | undefined
    if (row) {
      const fullPath = this.toNativePath(row.file_path)
      if (fs.existsSync(fullPath)) {
        this.stmtUpdateAccess.run(cacheKey)
        return { filePath: fullPath, mimeType: row.mime_type }
      }
      this.stmtDeleteById.run(row.id)
    }
    return null
  }

  readFile(filePath: string): Buffer {
    return fs.readFileSync(filePath)
  }

  store(cacheKey: string, mimeType: string, buffer: Buffer): string {
    const hash = crypto.createHash('sha256').update(cacheKey).digest('hex')
    const subDir = hash.substring(0, 2)
    const ext = this.mimeToExt(mimeType)
    const dirPath = path.join(this.cacheDir, subDir)
    fs.mkdirSync(dirPath, { recursive: true })

    const relativePath = `${subDir}/${hash}${ext}`
    const fullPath = this.toNativePath(relativePath)
    fs.writeFileSync(fullPath, buffer)

    this.stmtInsert.run({
      cacheKey,
      filePath: relativePath,
      mimeType,
      byteSize: buffer.length
    })

    this.evictIfNeeded()
    return fullPath
  }

  private mimeToExt(mime: string): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/bmp': '.bmp',
      'image/webp': '.webp',
      'image/tiff': '.tif'
    }
    return map[mime] || '.bin'
  }

  private evictIfNeeded(): void {
    const row = this.stmtTotalSize.get() as { total: number }
    if (row.total <= MAX_PREVIEW_CACHE_SIZE_BYTES) return

    const targetSize = MAX_PREVIEW_CACHE_SIZE_BYTES * 0.8
    let freed = 0
    const toFree = row.total - targetSize

    const rows = this.stmtEvictQuery.all(100) as Array<{
      id: number
      file_path: string
      byte_size: number
    }>

    for (const entry of rows) {
      if (freed >= toFree) break
      try {
        fs.unlinkSync(this.toNativePath(entry.file_path))
      } catch {
        // File already gone
      }
      this.stmtDeleteById.run(entry.id)
      freed += entry.byte_size
    }
  }
}
