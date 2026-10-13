import { ipcMain } from 'electron'
import { Writable } from 'stream'
import path from 'path'
import Database from 'better-sqlite3'
import { Client } from 'basic-ftp'
import { sessionIpcError, type ConnectionRegistry } from '../ftp/ConnectionRegistry'
import { PreviewCacheManager } from '../preview/PreviewCacheManager'
import { generateCacheKey } from '../utils/cacheKey'
import { MAX_IMAGE_SIZE_BYTES } from '@shared/constants'
import type { IpcResult } from '@shared/types/ipc'

async function downloadToBuffer(client: Client, remotePath: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  const writable = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk)
      callback()
    }
  })
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
  '.tif': 'image/tiff'
}

interface PreviewRequest {
  remotePath: string
  fileSize: number
  modifiedAt: string
}

export function registerPreviewHandlers(db: Database.Database, registry: ConnectionRegistry): void {
  const cacheManager = new PreviewCacheManager(db)

  ipcMain.handle(
    'ftp:downloadPreview',
    async (_event, conn: unknown, req: PreviewRequest): Promise<IpcResult<string>> => {
      try {
        const session = registry.require(conn)
        const ftpManager = session.manager
        if (req.fileSize > MAX_IMAGE_SIZE_BYTES) {
          return { success: false, error: 'File too large for preview' }
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
            buffer = await downloadToBuffer(secondaryClient, req.remotePath)
          } finally {
            secondaryClient.close()
          }
        } else {
          // runOnMainClient를 통해 list/transfer/delete 등과 직렬화하여 충돌 방지
          buffer = await ftpManager.runOnMainClient((client) =>
            downloadToBuffer(client, req.remotePath)
          )
        }

        // 캐시에 저장
        cacheManager.store(cacheKey, mime, buffer)

        const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
        return { success: true, data: dataUrl }
      } catch (err) {
        return sessionIpcError(err)
      }
    }
  )
}
