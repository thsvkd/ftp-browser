import sharp from 'sharp'
import { THUMBNAIL_SIZE, THUMBNAIL_QUALITY, MAX_IMAGE_SIZE_BYTES } from '@shared/constants'

interface CacheEntry {
  dataUrl: string
  width: number
  height: number
}

const MAX_CACHE_ENTRIES = 500

export class LocalThumbnailManager {
  private cache = new Map<string, CacheEntry>()

  buildCacheKey(localPath: string, fileSize: number, modifiedAt: string): string {
    return `${localPath}|${fileSize}|${modifiedAt}`
  }

  async getThumbnail(
    localPath: string,
    fileSize: number,
    modifiedAt: string
  ): Promise<CacheEntry & { cacheKey: string; fromCache: boolean }> {
    const cacheKey = this.buildCacheKey(localPath, fileSize, modifiedAt)
    const cached = this.cache.get(cacheKey)
    if (cached) {
      // LRU touch: re-insert to move to end
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached)
      return { ...cached, cacheKey, fromCache: true }
    }

    if (fileSize > MAX_IMAGE_SIZE_BYTES) {
      throw new Error('File too large for thumbnail')
    }

    const result = await sharp(localPath)
      .rotate()
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: THUMBNAIL_QUALITY })
      .toBuffer({ resolveWithObject: true })

    const entry: CacheEntry = {
      dataUrl: `data:image/jpeg;base64,${result.data.toString('base64')}`,
      width: result.info.width,
      height: result.info.height
    }

    this.cache.set(cacheKey, entry)
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) this.cache.delete(firstKey)
    }

    return { ...entry, cacheKey, fromCache: false }
  }

  clearAll(): void {
    this.cache.clear()
  }
}
