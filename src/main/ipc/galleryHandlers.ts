import { ipcMain, BrowserWindow } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import Database from 'better-sqlite3'
import { FtpMutationEvent } from '../ftp/FtpConnectionManager'
import { FtpSessionRegistry } from '../ftp/FtpSessionRegistry'
import { RemoteGalleryPreviewQueue } from '../ftp/RemoteGalleryPreviewQueue'
import { RemoteFolderPreviewCache } from '../ftp/RemoteFolderPreviewCache'
import { LocalThumbnailManager } from '../local/LocalThumbnailManager'
import { ipcError } from '../utils/errorClassifier'
import { getParentRemotePath, normalizeRemotePath } from '../utils/remotePath'
import { isImageFile } from '@shared/constants'
import type { IpcResult } from '@shared/types/ipc'
import type {
  LocalThumbnailRequest,
  LocalThumbnailResult,
  RemoteFolderPreviewRequest,
  RemoteFolderPreview,
  LocalFolderPreviewRequest,
  LocalFolderPreview
} from '@shared/types/gallery'

async function findFirstImageLocal(folderPath: string): Promise<LocalFolderPreview | null> {
  let dirents
  try {
    dirents = await fs.readdir(folderPath, { withFileTypes: true })
  } catch {
    return null
  }
  // readdir already omits "." / "..", so this is the item count for the folder.
  const entries = dirents.filter((d) => d.name !== '.' && d.name !== '..')
  const itemCount = entries.length
  for (const dirent of entries) {
    if (dirent.name.startsWith('.')) continue
    if (!dirent.isFile()) continue
    if (!isImageFile(dirent.name)) continue
    const fullPath = path.join(folderPath, dirent.name)
    try {
      const stat = await fs.stat(fullPath)
      return {
        name: dirent.name,
        path: fullPath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        itemCount
      }
    } catch {
      continue
    }
  }
  return null
}

export function registerGalleryHandlers(
  win: BrowserWindow,
  db: Database.Database,
  registry: FtpSessionRegistry
): LocalThumbnailManager {
  const localThumbnails = new LocalThumbnailManager()
  const folderCache = new RemoteFolderPreviewCache(db)

  // 세션마다 큐 하나(M4): LIST도 캐시도 그 세션의 host·port로 돈다(인자 생략 = primary, M3).
  const queues = new Map<string, RemoteGalleryPreviewQueue>()
  const queueFor = (server?: string): RemoteGalleryPreviewQueue => {
    const key = server ?? ''
    let queue = queues.get(key)
    if (!queue) {
      queue = new RemoteGalleryPreviewQueue(registry.get(server), folderCache)
      queues.set(key, queue)
    }
    return queue
  }

  // 원격 변경(delete/rename/mkdir/upload) 시 영향받는 폴더 미리보기를 자동 무효화.
  // 부모 폴더는 첫 이미지가 바뀔 수 있어서 무조건 invalidate. 대상 자체가 폴더인지
  // 파일인지 메타가 없으므로 안전하게 양쪽 모두 invalidate한다 (폴더가 아니면 no-op).
  // 캐시 키는 normalize된 path 기준이므로 invalidation도 동일하게 normalize해야 한다.
  registry.on('mutation', (event: FtpMutationEvent) => {
    // 태그가 있으면 그 세션의, 없으면 primary의 host·port로 무효화한다(M5).
    const manager = registry.get(event.server)
    if (!manager.isConnected()) return
    const host = manager.getHost()
    const port = manager.getPort()

    folderCache.invalidate(host, port, getParentRemotePath(event.remotePath))
    folderCache.invalidate(host, port, normalizeRemotePath(event.remotePath))

    if (event.kind === 'rename' && event.newPath) {
      folderCache.invalidate(host, port, getParentRemotePath(event.newPath))
      folderCache.invalidate(host, port, normalizeRemotePath(event.newPath))
    }
  })

  ipcMain.handle(
    'gallery:remoteFolderPreview',
    async (
      _event,
      req: RemoteFolderPreviewRequest,
      server?: string
    ): Promise<IpcResult<RemoteFolderPreview | null>> => {
      const session = registry.get(server)
      if (!session.isConnected()) {
        return { success: false, error: 'Not connected' }
      }
      try {
        const preview = await queueFor(server).request(req.remotePath)
        return { success: true, data: preview }
      } catch (err) {
        return ipcError(err)
      }
    }
  )

  ipcMain.handle('gallery:cancelAll', (): IpcResult<void> => {
    for (const queue of queues.values()) queue.cancelAll()
    return { success: true, data: undefined }
  })

  ipcMain.handle(
    'gallery:localFolderPreview',
    async (
      _event,
      req: LocalFolderPreviewRequest
    ): Promise<IpcResult<LocalFolderPreview | null>> => {
      try {
        const preview = await findFirstImageLocal(req.localPath)
        return { success: true, data: preview }
      } catch (err) {
        return ipcError(err)
      }
    }
  )

  ipcMain.handle(
    'localThumbnail:request',
    async (_event, req: LocalThumbnailRequest): Promise<IpcResult<string>> => {
      try {
        const result = await localThumbnails.getThumbnail(
          req.localPath,
          req.fileSize,
          req.modifiedAt
        )
        const evt: LocalThumbnailResult = {
          cacheKey: result.cacheKey,
          dataUrl: result.dataUrl,
          width: result.width,
          height: result.height,
          fromCache: result.fromCache
        }
        // Send asynchronously so the renderer flow mirrors the FTP thumbnail pattern
        if (!win.isDestroyed()) win.webContents.send('localThumbnail:ready', evt)
        return { success: true, data: result.cacheKey }
      } catch (err) {
        const cacheKey = localThumbnails.buildCacheKey(req.localPath, req.fileSize, req.modifiedAt)
        const message = err instanceof Error ? err.message : String(err)
        if (!win.isDestroyed()) {
          win.webContents.send('localThumbnail:error', { cacheKey, error: message })
        }
        return { success: false, error: message }
      }
    }
  )

  ipcMain.handle('localThumbnail:clear', (): IpcResult<void> => {
    localThumbnails.clearAll()
    return { success: true, data: undefined }
  })

  return localThumbnails
}
