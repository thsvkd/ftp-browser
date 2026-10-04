import { posix } from 'path'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import type { CacheManager } from '../thumbnail/CacheManager'
import type { ThumbnailGenerator } from '../thumbnail/ThumbnailGenerator'
import { ThumbnailQueue } from '../thumbnail/ThumbnailQueue'
import { generateCacheKey } from '../utils/cacheKey'
import type { PreviewOutcome, PreviewRequest } from './mcpTools'

/**
 * 앱 썸네일 파이프라인(같은 CacheManager·ThumbnailGenerator)으로 미리보기를 만든다.
 * 호출마다 전용 ThumbnailQueue를 만들고 끝나면 cancelAll로 보조 FTP 연결을 닫는다.
 * 앱 큐는 렌더러가 폴더를 옮길 때마다 비우지만 MCP에는 그런 신호가 없어, 큐를 남겨 두면
 * 재연결 뒤에도 이전 서버에 붙은 보조 연결을 재사용하게 된다.
 * `MAX_IMAGE_SIZE_BYTES`를 넘는 파일은 큐가 결과 없이 건너뛰므로 호출자가 미리 거른다.
 */
export function createThumbnailPreviewer(
  ftp: FtpConnectionManager,
  generator: ThumbnailGenerator,
  cache: CacheManager
): (requests: PreviewRequest[]) => Promise<PreviewOutcome[]> {
  return async (requests) => {
    const settle = new Map<string, (outcome: PreviewOutcome) => void>()
    const queue = new ThumbnailQueue(
      ftp,
      generator,
      cache,
      (result) =>
        settle.get(result.cacheKey)?.({
          ok: true,
          data: result.dataUrl.slice(result.dataUrl.indexOf(',') + 1),
          width: result.width,
          height: result.height
        }),
      (cacheKey, error) => settle.get(cacheKey)?.({ ok: false, error })
    )
    // 같은 파일을 두 번 요청하면 큐는 콜백을 한 번만 부르므로 같은 promise를 나눠 쓴다.
    const pending = new Map<string, Promise<PreviewOutcome>>()
    try {
      return await Promise.all(
        requests.map((req) => {
          const cacheKey = generateCacheKey(
            ftp.getHost(),
            ftp.getPort(),
            req.remotePath,
            req.fileSize,
            req.modifiedAt
          )
          let outcome = pending.get(cacheKey)
          if (!outcome) {
            // 캐시 적중은 request() 안에서 동기로 콜백하므로 resolve를 먼저 등록한다.
            outcome = new Promise((resolve) => settle.set(cacheKey, resolve))
            pending.set(cacheKey, outcome)
            queue.request({ ...req, fileName: posix.basename(req.remotePath), priority: 0 })
          }
          return outcome
        })
      )
    } finally {
      queue.cancelAll()
    }
  }
}
