import { THUMBNAIL_SIZE } from '@shared/constants'
import type { ConnKey } from '@shared/connKey'

/**
 * 썸네일·큰 미리보기의 캐시 키. 연결 키(`user@host:port`)를 넣는다: 같은 호스트·포트라도 사용자마다
 * 홈(chroot)이 달라 같은 경로가 다른 파일이다(multi-connection MC9).
 */
export function generateCacheKey(
  conn: ConnKey,
  remotePath: string,
  fileSize: number,
  modifiedAt: string
): string {
  // THUMBNAIL_SIZE is part of the key so changing it invalidates stale caches.
  return `${conn}:${remotePath}:${fileSize}:${modifiedAt}:${THUMBNAIL_SIZE}`
}
