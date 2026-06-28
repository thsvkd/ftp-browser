import { THUMBNAIL_SIZE } from '@shared/constants'

export function generateCacheKey(
  host: string,
  port: number,
  remotePath: string,
  fileSize: number,
  modifiedAt: string
): string {
  // THUMBNAIL_SIZE is part of the key so changing it invalidates stale caches.
  return `${host}:${port}:${remotePath}:${fileSize}:${modifiedAt}:${THUMBNAIL_SIZE}`
}
