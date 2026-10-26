import { ipcMain } from 'electron'
import { Writable } from 'stream'
import path from 'path'
import Database from 'better-sqlite3'
import { Client } from 'basic-ftp'
import { sessionIpcError, type ConnectionRegistry } from '../ftp/ConnectionRegistry'
import { PreviewCacheManager } from '../preview/PreviewCacheManager'
import { generateCacheKey } from '../utils/cacheKey'
import { isVideoFile, MAX_IMAGE_SIZE_BYTES, MAX_VIDEO_SIZE_BYTES } from '@shared/constants'
import type { IpcResult } from '@shared/types/ipc'

const TOO_LARGE = 'File too large for preview'

/** 진행 중인 미리보기 다운로드 하나. 새 요청이 오면 앞의 것을 cancel()한다. */
interface PreviewDownload {
  cancelled: boolean
  writable?: Writable
}

/**
 * 받은 바이트가 cap을 넘으면 Writable을 에러로 끝내 중단한다(목록 size는 믿지 않는다).
 * basic-ftp는 목적지 스트림 에러를 받으면 전송을 접고 reject한다.
 * `abortable`이 false(메인 클라이언트)면 새 요청이 와도 끊지 않는다: basic-ftp가 목적지 스트림
 * 오류에 제어 연결까지 닫기 때문이다(F13). 시작 전에 밀려났으면 건너뛴다.
 */
async function downloadToBuffer(
  client: Client,
  remotePath: string,
  cap: number,
  job: PreviewDownload,
  abortable: boolean
): Promise<Buffer> {
  if (job.cancelled) throw new Error('Preview cancelled')
  const chunks: Buffer[] = []
  let received = 0
  const writable = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      if (received > cap) return callback(new Error(TOO_LARGE))
      chunks.push(chunk)
      callback()
    }
  })
  if (abortable) job.writable = writable
  await client.downloadTo(writable, remotePath)
  return Buffer.concat(chunks)
}

export const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4'
}

interface PreviewRequest {
  remotePath: string
  fileSize: number
  modifiedAt: string
}

export function registerPreviewHandlers(db: Database.Database, registry: ConnectionRegistry): void {
  const cacheManager = new PreviewCacheManager(db)
  // 연결마다 원격 미리보기 다운로드는 하나만 진행한다. 라이트박스를 빨리 넘겨도 연결이 쌓이지 않는다.
  const inflight = new Map<string, PreviewDownload>()

  ipcMain.handle(
    'ftp:downloadPreview',
    async (_event, conn: unknown, req: PreviewRequest): Promise<IpcResult<string>> => {
      let job: PreviewDownload | undefined
      let jobKey = ''
      try {
        const session = registry.require(conn)
        const ftpManager = session.manager
        jobKey = session.key
        const prev = inflight.get(jobKey)
        if (prev) {
          prev.cancelled = true
          prev.writable?.destroy(new Error('Preview cancelled'))
        }
        job = { cancelled: false }
        inflight.set(jobKey, job)
        // data URL은 파일 전체를 메모리에 올려야 하므로 종류별 상한을 나눈다(P5·함정 D).
        const cap = isVideoFile(req.remotePath) ? MAX_VIDEO_SIZE_BYTES : MAX_IMAGE_SIZE_BYTES
        if (req.fileSize > cap) {
          return { success: false, error: TOO_LARGE }
        }

        const ext = path.extname(req.remotePath).toLowerCase()
        const mime = MIME_MAP[ext] || 'image/jpeg'

        // 캐시 키 생성
        const cacheKey = generateCacheKey(session.key, req.remotePath, req.fileSize, req.modifiedAt)

        // 캐시 조회
        const cached = cacheManager.lookup(cacheKey)
        if (cached) {
          const buffer = cacheManager.readFile(cached.filePath)
          const dataUrl = `data:${cached.mimeType};base64,${buffer.toString('base64')}`
          return { success: true, data: dataUrl }
        }

        // FTP에서 다운로드 (보조 클라이언트 시도 → 실패 시 메인 클라이언트로 직렬화 fallback)
        let secondaryClient: Client | null = null
        try {
          secondaryClient = await ftpManager.createSecondaryClient()
        } catch {
          // 보조 클라이언트 생성 실패 → 메인 클라이언트 사용
        }

        let buffer: Buffer
        if (secondaryClient) {
          try {
            buffer = await downloadToBuffer(secondaryClient, req.remotePath, cap, job, true)
          } finally {
            secondaryClient.close()
          }
        } else {
          // runOnMainClient를 통해 list/transfer/delete 등과 직렬화하여 충돌 방지
          buffer = await ftpManager.runOnMainClient((client) =>
            downloadToBuffer(client, req.remotePath, cap, job!, false)
          )
        }

        // 캐시에 저장
        cacheManager.store(cacheKey, mime, buffer)

        const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
        return { success: true, data: dataUrl }
      } catch (err) {
        return sessionIpcError(err)
      } finally {
        if (job && inflight.get(jobKey) === job) inflight.delete(jobKey)
      }
    }
  )
}
