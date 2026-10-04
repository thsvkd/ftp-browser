import { ipcMain, BrowserWindow } from 'electron'
import Database from 'better-sqlite3'
import { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import { ThumbnailGenerator } from '../thumbnail/ThumbnailGenerator'
import { CacheManager } from '../thumbnail/CacheManager'
import { ThumbnailQueue, ThumbnailRequest, ThumbnailResult } from '../thumbnail/ThumbnailQueue'
import { ipcError } from '../utils/errorClassifier'
import type { IpcResult } from '@shared/types/ipc'

export interface ThumbnailHandlersResult {
  queue: ThumbnailQueue
  /** MCP 미리보기가 같은 캐시와 생성기를 쓰도록 내보낸다 */
  cacheManager: CacheManager
  generator: ThumbnailGenerator
}

export function registerThumbnailHandlers(
  win: BrowserWindow,
  db: Database.Database,
  ftpManager: FtpConnectionManager
): ThumbnailHandlersResult {
  const cacheManager = new CacheManager(db)
  const generator = new ThumbnailGenerator()

  const queue = new ThumbnailQueue(
    ftpManager,
    generator,
    cacheManager,
    (result: ThumbnailResult) => {
      win.webContents.send('thumbnail:ready', result)
    },
    (cacheKey: string, error: string) => {
      win.webContents.send('thumbnail:error', { cacheKey, error })
    }
  )

  ipcMain.handle('thumbnail:request', (_event, req: ThumbnailRequest): IpcResult<string> => {
    try {
      const cacheKey = queue.request(req)
      return { success: true, data: cacheKey }
    } catch (err) {
      return ipcError(err)
    }
  })

  // 원격 그리드의 뷰포트 배치(보이는 행 ± 한 화면, 가까운 순 priority). 단순 묶음 요청이 아니라
  // 직전 배치를 **교체**한다: 직전 배치에서 아직 시작하지 않았고 이번에 빠진 항목은 버린다.
  // 진행 중 다운로드와 단건 thumbnail:request 항목은 그대로 둔다(docs/handoff/thumbnail-viewport-priority.md).
  ipcMain.handle(
    'thumbnail:requestBatch',
    (_event, requests: ThumbnailRequest[]): IpcResult<string[]> => {
      try {
        const keys = queue.requestBatch(requests)
        return { success: true, data: keys }
      } catch (err) {
        return ipcError(err)
      }
    }
  )

  ipcMain.handle('thumbnail:cancelAll', (): IpcResult<void> => {
    queue.cancelAll()
    return { success: true, data: undefined }
  })

  ipcMain.handle('cache:getStats', (): IpcResult<{ totalBytes: number; totalCount: number }> => {
    const stats = cacheManager.getStats()
    return { success: true, data: stats }
  })

  ipcMain.handle('cache:clear', (): IpcResult<void> => {
    cacheManager.clearAll()
    return { success: true, data: undefined }
  })

  return { queue, cacheManager, generator }
}
