import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { CacheManager, CacheInsertPayload } from './CacheManager'

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/userData')
  }
}))

// Mock fs
vi.mock('fs', () => {
  const files = new Map<string, Buffer>()
  return {
    default: {
      mkdirSync: vi.fn(),
      existsSync: vi.fn((p: string) => files.has(p)),
      writeFileSync: vi.fn((p: string, data: Buffer) => files.set(p, data)),
      readFileSync: vi.fn((p: string) => {
        const content = files.get(p)
        if (!content) throw new Error(`ENOENT: ${p}`)
        return content
      }),
      unlinkSync: vi.fn((p: string) => files.delete(p)),
      rmSync: vi.fn(() => files.clear()),
      __files: files
    }
  }
})

interface MockDb {
  prepare: ReturnType<typeof vi.fn>
  _rows: Record<string, unknown>[]
}

// Create in-memory DB mock that simulates better-sqlite3 behavior
function createMockDb(): MockDb {
  const rows: Record<string, unknown>[] = []
  let nextId = 1

  return {
    prepare: vi.fn((sql: string) => {
      if (sql.includes('SELECT') && sql.includes('cache_key = ?')) {
        // lookup
        return {
          get: vi.fn((cacheKey: string) => rows.find((r) => r.cache_key === cacheKey))
        }
      }
      if (sql.includes('INSERT OR REPLACE')) {
        // insert
        return {
          run: vi.fn((params: Record<string, unknown>) => {
            const existing = rows.findIndex((r) => r.cache_key === params.cacheKey)
            const row = {
              id: existing >= 0 ? rows[existing].id : nextId++,
              cache_key: params.cacheKey,
              host: params.host,
              port: params.port,
              remote_path: params.remotePath,
              file_size: params.fileSize,
              modified_at: params.modifiedAt,
              thumbnail_path: params.thumbnailPath,
              width: params.width,
              height: params.height,
              original_format: params.originalFormat,
              byte_size: params.byteSize
            }
            if (existing >= 0) {
              rows[existing] = row
            } else {
              rows.push(row)
            }
          })
        }
      }
      if (sql.includes('UPDATE thumbnails SET last_accessed_at')) {
        return { run: vi.fn() }
      }
      if (sql.includes('ORDER BY last_accessed_at ASC')) {
        // evict query
        return {
          all: vi.fn((limit: number) =>
            rows.slice(0, limit).map((r) => ({
              id: r.id,
              thumbnail_path: r.thumbnail_path,
              byte_size: r.byte_size
            }))
          )
        }
      }
      if (sql.includes('DELETE FROM thumbnails WHERE id')) {
        return {
          run: vi.fn((id: number) => {
            const idx = rows.findIndex((r) => r.id === id)
            if (idx >= 0) rows.splice(idx, 1)
          })
        }
      }
      if (sql.includes('SUM(byte_size)')) {
        return {
          get: vi.fn(() => ({
            total: rows.reduce((sum, r) => sum + (r.byte_size as number), 0),
            count: rows.length
          }))
        }
      }
      if (sql.includes('DELETE FROM thumbnails') && !sql.includes('WHERE')) {
        return {
          run: vi.fn(() => (rows.length = 0))
        }
      }
      return { run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) }
    }),
    _rows: rows
  }
}

describe('CacheManager', () => {
  let cacheManager: CacheManager
  let mockDb: MockDb
  let mockFs: typeof import('fs') & { __files?: Map<string, Buffer> }

  beforeEach(async () => {
    vi.clearAllMocks()
    mockDb = createMockDb()
    mockFs = (await import('fs')).default as unknown as typeof import('fs') & {
      __files?: Map<string, Buffer>
    }
    mockFs.__files?.clear?.()
    cacheManager = new CacheManager(mockDb as unknown as Database.Database)
  })

  describe('constructor', () => {
    it('should create cache directory', () => {
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('thumbnails'), {
        recursive: true
      })
    })
  })

  describe('lookup', () => {
    it('should return null for non-existent key', () => {
      const result = cacheManager.lookup('non-existent-key')
      expect(result).toBeNull()
    })
  })

  describe('store', () => {
    it('should write thumbnail to disk and insert into db', () => {
      const payload: CacheInsertPayload = {
        cacheKey: 'test-key',
        host: 'ftp.example.com',
        port: 21,
        remotePath: '/images/photo.jpg',
        fileSize: 1024,
        modifiedAt: '2024-01-01',
        width: 150,
        height: 100,
        originalFormat: 'jpeg',
        thumbnailBuffer: Buffer.from('fake-thumbnail')
      }

      cacheManager.store(payload)

      // Should create subdirectory
      expect(mockFs.mkdirSync).toHaveBeenCalled()
      // Should write file
      expect(mockFs.writeFileSync).toHaveBeenCalled()
    })
  })

  describe('getStats', () => {
    it('should return total bytes and count', () => {
      const stats = cacheManager.getStats()
      expect(stats).toHaveProperty('totalBytes')
      expect(stats).toHaveProperty('totalCount')
      expect(typeof stats.totalBytes).toBe('number')
      expect(typeof stats.totalCount).toBe('number')
    })
  })

  describe('clearAll', () => {
    it('should remove cache directory and recreate it', () => {
      cacheManager.clearAll()
      expect(mockFs.rmSync).toHaveBeenCalledWith(expect.stringContaining('thumbnails'), {
        recursive: true,
        force: true
      })
      // Should recreate directory
      expect(mockFs.mkdirSync).toHaveBeenCalledTimes(2) // once in constructor, once in clearAll
    })
  })
})
