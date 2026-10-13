import { ipcMain, BrowserWindow } from 'electron'
import { mkdir } from 'fs/promises'
import type { TransferHub } from '../transfer/TransferHub'
import { planDownload, planUpload, resolvePlan, type PlanDeps } from '../transfer/folderPlan'
import { sessionIpcError, type ConnectionRegistry } from '../ftp/ConnectionRegistry'
import { LocalFileSystem } from '../local/LocalFileSystem'
import { ipcError } from '../utils/errorClassifier'
import type {
  TransferJob,
  TransferUpdate,
  TransferDirection,
  TransferEnqueueItem,
  TransferSendRequest,
  TransferSendResult
} from '@shared/types/transfer'
import type { IpcResult } from '@shared/types/ipc'

interface EnqueuePayload {
  direction: TransferDirection
  localPath: string
  remotePath: string
  fileName: string
  totalBytes: number
}

interface EnqueueBatchPayload {
  direction: TransferDirection
  items: TransferEnqueueItem[]
  forceBatch?: boolean
  /** 업로드 전에 만들어야 하는 원격 디렉터리(중간 경로 포함) */
  remoteDirs?: string[]
}

/**
 * 전송 채널. 큐는 연결마다 하나(세션)이고, 큐에 넣는 채널은 첫 인자 연결 키의 큐로 간다. id로 오는 명령과
 * 목록·변경 알림은 허브가 모든 큐에 나눠 보낸다(MC6).
 */
export function registerTransferHandlers(
  win: BrowserWindow,
  registry: ConnectionRegistry,
  hub: TransferHub,
  localFs: LocalFileSystem
): void {
  hub.on('queue:updated', (update: TransferUpdate) => {
    if (!win.isDestroyed()) win.webContents.send('transfer:updated', update)
  })

  ipcMain.handle(
    'transfer:enqueue',
    (_event, conn: unknown, payload: EnqueuePayload): IpcResult<string> => {
      try {
        const id = registry
          .require(conn)
          .queue.enqueue(
            payload.direction,
            payload.localPath,
            payload.remotePath,
            payload.fileName,
            payload.totalBytes
          )
        return { success: true, data: id }
      } catch (err) {
        return sessionIpcError(err)
      }
    }
  )

  ipcMain.handle(
    'transfer:enqueueBatch',
    (_event, conn: unknown, payload: EnqueueBatchPayload): IpcResult<string[]> => {
      try {
        const ids = registry
          .require(conn)
          .queue.enqueueBatch(
            payload.direction,
            payload.items,
            payload.forceBatch,
            payload.remoteDirs
          )
        return { success: true, data: ids }
      } catch (err) {
        return sessionIpcError(err)
      }
    }
  )

  // 보내기 계획은 상태 없이 매번 새로 세운다(D8). 결정 없는 충돌이 있으면 아무것도 넣지 않고 그 충돌만 돌려주고,
  // 렌더러가 결정을 모아 같은 요청을 다시 보낸다. 다운로드는 배타적이지 않다: 덮어쓰기 결정이 가능해야 한다(D12).
  ipcMain.handle(
    'transfer:send',
    async (
      _event,
      conn: unknown,
      req: TransferSendRequest
    ): Promise<IpcResult<TransferSendResult>> => {
      try {
        // upload·download는 conn이 원격 쪽이다
        const { manager, queue } = registry.require(conn)
        const planDeps: PlanDeps = {
          list: (dir) => manager.list(dir),
          collectFiles: (dir) => localFs.collectFiles(dir),
          platform: process.platform
        }
        const upload = req.direction === 'upload'
        const plan = upload
          ? await planUpload(planDeps, req.sources, req.destDir)
          : await planDownload(planDeps, req.sources, req.destDir)
        const { items, skipped, unresolved, totalBytes } = resolvePlan(
          plan,
          (c) => req.decisions?.[c.target]
        )
        if (unresolved.length > 0) {
          return { success: true, data: { ids: [], skipped, conflicts: unresolved, totalBytes } }
        }
        // 다운로드가 만들 로컬 폴더는 큐에 넣기 직전에만 만든다
        if (!upload) for (const dir of plan.dirs) await mkdir(dir, { recursive: true })
        const ids = queue.enqueueBatch(req.direction, items, true, upload ? plan.dirs : undefined)
        const batchId = queue.getAll().find((job) => job.id === ids[0])?.batchId
        return { success: true, data: { batchId, ids, skipped, conflicts: [], totalBytes } }
      } catch (err) {
        return sessionIpcError(err)
      }
    }
  )

  ipcMain.handle('transfer:retry', (_event, ids: string[]): IpcResult<void> => {
    try {
      hub.retry(ids)
      return { success: true, data: undefined }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('transfer:cancel', (_event, id: string): IpcResult<void> => {
    try {
      hub.cancel(id)
      return { success: true, data: undefined }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('transfer:clearCompleted', (): IpcResult<void> => {
    try {
      hub.clearCompleted()
      return { success: true, data: undefined }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('transfer:getAll', (): IpcResult<TransferJob[]> => {
    return { success: true, data: hub.getAll() }
  })
}
