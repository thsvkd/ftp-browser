import { ipcMain, BrowserWindow } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { sessionIpcError, type ConnectionRegistry } from '../ftp/ConnectionRegistry'
import type { RemoteFolderPreviewCache } from '../ftp/RemoteFolderPreviewCache'
import { LocalThumbnailManager } from '../local/LocalThumbnailManager'
import { ipcError } from '../utils/errorClassifier'
import { getParentRemotePath, normalizeRemotePath } from '../utils/remotePath'
import { INVALID_VIEWER, isViewerId, sessionsOf } from './thumbnailHandlers'
import { isImageFile } from '@shared/constants'
import { parseConnKey } from '@shared/connKey'
import type { RemoteChangedEvent } from '@shared/types/ftp'
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

/**
 * 폴더 미리보기 채널. 원격 큐는 연결마다 하나(세션의 `gallery`)이고 캐시는 앱에 하나다(세션 팩토리와
 * 함께 쓴다).
 */
export function registerGalleryHandlers(
  win: BrowserWindow,
  registry: ConnectionRegistry,
  folderCache: RemoteFolderPreviewCache
): LocalThumbnailManager {
  const localThumbnails = new LocalThumbnailManager()

  // 원격 변경(delete/rename/mkdir/upload) 시 영향받는 폴더 미리보기를 자동 무효화.
  // 부모 폴더는 첫 이미지가 바뀔 수 있어서 무조건 invalidate. 대상 자체가 폴더인지
  // 파일인지 메타가 없으므로 안전하게 양쪽 모두 invalidate한다 (폴더가 아니면 no-op).
  // 캐시 키는 normalize된 path 기준이므로 invalidation도 동일하게 normalize해야 한다.
  registry.on('mutation', (event: RemoteChangedEvent) => {
    if (!registry.get(event.server)?.manager.isConnected()) return
    const { host, port, user } = parseConnKey(event.server)!

    folderCache.invalidate(host, port, user, getParentRemotePath(event.remotePath))
    folderCache.invalidate(host, port, user, normalizeRemotePath(event.remotePath))

    if (event.kind === 'rename' && event.newPath) {
      folderCache.invalidate(host, port, user, getParentRemotePath(event.newPath))
      folderCache.invalidate(host, port, user, normalizeRemotePath(event.newPath))
    }
  })

  ipcMain.handle(
    'gallery:remoteFolderPreview',
    async (
      _event,
      conn: unknown,
      req: RemoteFolderPreviewRequest
    ): Promise<IpcResult<RemoteFolderPreview | null>> => {
      if (!isViewerId(req?.viewerId)) return INVALID_VIEWER
      try {
        const preview = await registry.require(conn).gallery.request(req.remotePath, req.viewerId)
        return { success: true, data: preview }
      } catch (err) {
        return sessionIpcError(err)
      }
    }
  )

  // conn이 null이면 모든 세션에서 그 뷰어를 폴더 미리보기 소유에서 뺀다
  ipcMain.handle(
    'gallery:cancelAll',
    (_event, conn: string | null, viewerId: unknown): IpcResult<void> => {
      if (!isViewerId(viewerId)) return INVALID_VIEWER
      for (const session of sessionsOf(registry, conn)) session.gallery.cancelAll(viewerId)
      return { success: true, data: undefined }
    }
  )

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
