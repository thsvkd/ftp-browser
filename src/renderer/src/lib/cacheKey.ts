import { THUMBNAIL_SIZE } from '@shared/constants'
import type { ConnKey } from '@shared/connKey'

export function generateCacheKeyRenderer(
  conn: ConnKey,
  remotePath: string,
  fileSize: number,
  modifiedAt: string
): string {
  // Must stay identical to the main-process generateCacheKey (incl. THUMBNAIL_SIZE).
  return `${conn}:${remotePath}:${fileSize}:${modifiedAt}:${THUMBNAIL_SIZE}`
}
