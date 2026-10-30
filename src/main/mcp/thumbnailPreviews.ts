import { posix } from 'path'
import type { EventEmitter } from 'events'
import { MAX_IMAGE_SIZE_BYTES } from '@shared/constants'
import type { ConnKey } from '@shared/connKey'
import type { FtpConnectionState } from '@shared/types/ftp'
import type { CacheManager } from '../thumbnail/CacheManager'
import type { ThumbnailGenerator } from '../thumbnail/ThumbnailGenerator'
import { ThumbnailQueue, type ThumbnailSource } from '../thumbnail/ThumbnailQueue'
import { generateCacheKey } from '../utils/cacheKey'
import type { PreviewOutcome, PreviewRequest } from './mcpTools'

const STOPPED: PreviewOutcome = { ok: false, error: 'The user stopped this call.' }
const CONNECTION_CHANGED: PreviewOutcome = {
  ok: false,
  error: 'The FTP connection changed before this preview was made. Request it again.'
}

/** 미리보기가 쓰는 연결들(ConnectionRegistry의 일부). 상태 알림은 `server`가 붙은 FtpConnectionState다. */
export type PreviewSessions = {
  get(key: ConnKey): { manager: ThumbnailSource } | undefined
} & Pick<EventEmitter, 'on'>

type Previewer = ((
  requests: PreviewRequest[],
  isStopped?: () => boolean
) => Promise<PreviewOutcome[]>) & {
  /** 그 연결의 상태가 바뀌었다 */
  reset(): void
}

/**
 * 앱 썸네일 파이프라인(같은 CacheManager·ThumbnailGenerator)으로 그 연결에서 미리보기를 만든다.
 * MCP 전용 ThumbnailQueue는 연결마다 하나이고(multi-connection MC22), 파일을 한 번에 하나씩 넣어 연결마다
 * 보조 FTP 연결을 최대 1개만 쓴다. 연결이 없으면 그 요청들은 실패다.
 */
export function createThumbnailPreviewer(
  sessions: PreviewSessions,
  generator: ThumbnailGenerator,
  cache: CacheManager
): (
  conn: ConnKey,
  requests: PreviewRequest[],
  isStopped?: () => boolean
) => Promise<PreviewOutcome[]> {
  const previewers = new Map<ConnKey, Previewer>()
  sessions.on('connectionStatus', (state: FtpConnectionState) => {
    previewers.get(state.server)?.reset()
  })
  return async (conn, requests, isStopped) => {
    let previewer = previewers.get(conn)
    if (!previewer) {
      const session = sessions.get(conn)
      if (!session) return requests.map(() => ({ ok: false, error: `Not connected to ${conn}.` }))
      previewer = sessionPreviewer(session.manager, generator, cache)
      previewers.set(conn, previewer)
    }
    return previewer(requests, isStopped)
  }
}

/**
 * 한 연결의 미리보기. 동시에 온 호출은 도착 순서대로 기다린다. 할 일이 없어지면 보조 연결을 닫고, 그
 * 연결의 상태가 바뀌면(다시 연결·해제·끊김) 기다리던 미리보기를 실패로 끝내고 큐를 비운다. 이전 로그인에
 * 붙은 보조 연결을 재사용하지 않기 위해서다.
 * `MAX_IMAGE_SIZE_BYTES`를 넘는 파일은 큐가 결과 없이 건너뛰므로 여기서 바로 실패로 돌려준다.
 */
function sessionPreviewer(
  ftp: ThumbnailSource,
  generator: ThumbnailGenerator,
  cache: CacheManager
): Previewer {
  /** 큐에 넣은 한 파일의 결과를 기다리는 쪽. 한 번에 하나뿐이다. */
  let inFlight: { cacheKey: string; settle: (outcome: PreviewOutcome) => void } | null = null
  const finish = (cacheKey: string, outcome: PreviewOutcome): void => {
    if (inFlight?.cacheKey !== cacheKey) return
    const { settle } = inFlight
    inFlight = null
    settle(outcome)
  }
  const createQueue = (): ThumbnailQueue =>
    new ThumbnailQueue(
      ftp,
      generator,
      cache,
      (result) =>
        finish(result.cacheKey, {
          ok: true,
          data: result.dataUrl.slice(result.dataUrl.indexOf(',') + 1),
          width: result.width,
          height: result.height
        }),
      (cacheKey, error) => finish(cacheKey, { ok: false, error })
    )
  let queue = createQueue()

  let generation = 0
  const reset = (): void => {
    generation++
    queue.cancelAll()
    // 취소된 다운로드는 몇 틱 뒤에야 큐의 진행 목록에서 빠진다. 그사이 같은 파일 요청이 무시되지 않게
    // 큐를 새로 만든다.
    queue = createQueue()
    if (inFlight) finish(inFlight.cacheKey, CONNECTION_CHANGED)
  }

  const previewOne = (req: PreviewRequest): Promise<PreviewOutcome> => {
    if (req.fileSize > MAX_IMAGE_SIZE_BYTES) {
      return Promise.resolve({ ok: false, error: 'Image is too large to preview.' })
    }
    const cacheKey = generateCacheKey(
      ftp.getConnKey(),
      req.remotePath,
      req.fileSize,
      req.modifiedAt
    )
    return new Promise((resolve) => {
      // 캐시 적중은 request() 안에서 동기로 콜백하므로 기다리는 쪽을 먼저 둔다.
      inFlight = { cacheKey, settle: resolve }
      queue.request({ ...req, fileName: posix.basename(req.remotePath), priority: 0 })
    })
  }

  let tail: Promise<unknown> = Promise.resolve()
  let calls = 0
  const preview = async (
    requests: PreviewRequest[],
    isStopped: () => boolean = () => false
  ): Promise<PreviewOutcome[]> => {
    const started = generation
    calls++
    const run = tail.then(async () => {
      const outcomes: PreviewOutcome[] = []
      // 같은 파일을 두 번 요청하면 한 번만 만든다.
      const done = new Map<string, PreviewOutcome>()
      for (const req of requests) {
        if (generation !== started) {
          outcomes.push(CONNECTION_CHANGED)
          continue
        }
        // 사용자가 그 에이전트 호출을 중지했으면 남은 파일을 받지 않는다(agent-activity A14)
        if (isStopped()) {
          outcomes.push(STOPPED)
          continue
        }
        const outcome = done.get(req.remotePath) ?? (await previewOne(req))
        done.set(req.remotePath, outcome)
        outcomes.push(outcome)
      }
      return outcomes
    })
    tail = run.catch(() => undefined)
    try {
      return await run
    } finally {
      // 기다리는 호출이 없으면 보조 연결을 닫는다. 유휴 연결을 서버가 끊어 다음 호출이 실패하지 않게 한다.
      if (--calls === 0) queue.cancelAll()
    }
  }
  return Object.assign(preview, { reset })
}
