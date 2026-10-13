import { ipcMain, BrowserWindow } from 'electron'
import { CacheManager } from '../thumbnail/CacheManager'
import type { ThumbnailRequest, ThumbnailResult } from '../thumbnail/ThumbnailQueue'
import {
  sessionIpcError,
  type ConnectionRegistry,
  type FtpSession,
  type SessionShared
} from '../ftp/ConnectionRegistry'
import type { IpcResult } from '@shared/types/ipc'

/** 세션마다 있는 썸네일 큐의 결과를 렌더러로 보낸다. 세션 팩토리가 받는다(index.ts). */
export function thumbnailEvents(
  win: BrowserWindow
): Pick<SessionShared, 'onThumbnailReady' | 'onThumbnailError'> {
  return {
    onThumbnailReady: (result: ThumbnailResult) => {
      if (!win.isDestroyed()) win.webContents.send('thumbnail:ready', result)
    },
    onThumbnailError: (cacheKey: string, error: string) => {
      if (!win.isDestroyed()) win.webContents.send('thumbnail:error', { cacheKey, error })
    }
  }
}

/**
 * 썸네일 채널. 큐는 연결마다 하나(세션의 `thumbs`)이고, 요청은 첫 인자 연결 키의 큐로 간다. 캐시와 생성기는
 * 앱에 하나다(세션 팩토리가 함께 쓴다).
 */
export function registerThumbnailHandlers(
  registry: ConnectionRegistry,
  cacheManager: CacheManager
): void {
  ipcMain.handle(
    'thumbnail:request',
    (_event, conn: unknown, req: ThumbnailRequest): IpcResult<string> => {
      try {
        const cacheKey = registry.require(conn).thumbs.request(req)
        return { success: true, data: cacheKey }
      } catch (err) {
        return sessionIpcError(err)
      }
    }
  )

  // 원격 그리드의 뷰포트 배치(보이는 행 ± 한 화면, 가까운 순 priority). 단순 묶음 요청이 아니라
  // 그 (연결, 뷰어)의 직전 배치를 **교체**한다: 직전 배치에서 아직 시작하지 않았고 이번에 빠진 항목은
  // 다른 뷰어도 원하지 않을 때만 버린다. 진행 중 다운로드와 단건 thumbnail:request 항목은 그대로 둔다
  // (docs/handoff/thumbnail-viewport-priority.md, multi-connection.md §4.3).
  ipcMain.handle(
    'thumbnail:requestBatch',
    (
      _event,
      conn: unknown,
      viewerId: unknown,
      requests: ThumbnailRequest[]
    ): IpcResult<string[]> => {
      if (!isViewerId(viewerId)) return INVALID_VIEWER
      try {
        const keys = registry.require(conn).thumbs.requestBatch(viewerId, requests)
        return { success: true, data: keys }
      } catch (err) {
        return sessionIpcError(err)
      }
    }
  )

  // conn이 null이면 모든 세션에서 그 뷰어의 배치를 취소한다
  ipcMain.handle(
    'thumbnail:cancelAll',
    (_event, conn: string | null, viewerId: unknown): IpcResult<void> => {
      if (!isViewerId(viewerId)) return INVALID_VIEWER
      for (const session of sessionsOf(registry, conn)) session.thumbs.cancelAll(viewerId)
      return { success: true, data: undefined }
    }
  )

  ipcMain.handle('cache:getStats', (): IpcResult<{ totalBytes: number; totalCount: number }> => {
    const stats = cacheManager.getStats()
    return { success: true, data: stats }
  })

  ipcMain.handle('cache:clear', (): IpcResult<void> => {
    cacheManager.clearAll()
    return { success: true, data: undefined }
  })
}

/** 뷰어 id(패널 id)는 1~64자 문자열이다(multi-connection §4.3-1) */
export function isViewerId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64
}

export const INVALID_VIEWER = { success: false, error: 'Invalid viewer id.' } as const

/** 취소 채널의 대상: 그 키의 세션, `null`이면 모든 세션 */
export function sessionsOf(registry: ConnectionRegistry, conn: string | null): FtpSession[] {
  if (conn === null) return registry.sessions()
  const session = registry.get(conn)
  return session ? [session] : []
}
