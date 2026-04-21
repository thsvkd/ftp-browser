import { ipcMain, BrowserWindow } from 'electron'
import Database from 'better-sqlite3'
import { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import { ThumbnailGenerator } from '../thumbnail/ThumbnailGenerator'
import { CacheManager } from '../thumbnail/CacheManager'
import { ThumbnailQueue, ThumbnailRequest, ThumbnailResult } from '../thumbnail/ThumbnailQueue'
import { ipcError } from '../utils/errorClassifier'
import type { IpcResult } from '@shared/types/ipc'

export function registerThumbnailHandlers(
  win: BrowserWindow,
  db: Database.Database,
  ftpManager: FtpConnectionManager
): ThumbnailQueue {
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

  ipcMain.handle(
    'thumbnail:requestBatch',
    (_event, requests: ThumbnailRequest[]): IpcResult<string[]> => {
      try {
        const keys = requests.map((req) => queue.request(req))
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

  return queue
}
