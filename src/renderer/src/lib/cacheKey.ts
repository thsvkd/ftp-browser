import { THUMBNAIL_SIZE } from '@shared/constants'

export function generateCacheKeyRenderer(
  host: string,
  port: number,
  remotePath: string,
  fileSize: number,
  modifiedAt: string
): string {
  // Must stay identical to the main-process generateCacheKey (incl. THUMBNAIL_SIZE).
  return `${host}:${port}:${remotePath}:${fileSize}:${modifiedAt}:${THUMBNAIL_SIZE}`
}
