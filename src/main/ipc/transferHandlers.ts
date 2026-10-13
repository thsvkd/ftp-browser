import { ipcMain, BrowserWindow } from 'electron'
import { mkdir } from 'fs/promises'
import { TransferQueue } from '../transfer/TransferQueue'
import { TransferClientPool } from '../transfer/TransferClientPool'
import { planDownload, planUpload, resolvePlan, type PlanDeps } from '../transfer/folderPlan'
import { FtpFileOperations } from '../ftp/FtpFileOperations'
import { FtpConnectionManager } from '../ftp/FtpConnectionManager'
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
import { ErrorCode, type IpcResult } from '@shared/types/ipc'

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

export function registerTransferHandlers(
  win: BrowserWindow,
  fileOps: FtpFileOperations,
  manager: FtpConnectionManager,
  localFs: LocalFileSystem
): TransferQueue {
  // 전송은 전용 연결 풀에서 돌아 메인 클라이언트(탐색)를 막지 않는다
  // 매니저가 하나인 동안은 작업이 만들어지는 때의 연결이 작업의 `server`다(S1에서 세션 큐가 고정 키를 받는다)
  const queue = new TransferQueue(fileOps, new TransferClientPool(manager), {
    server: () => manager.getConnKey()
  })

  queue.on('queue:updated', (update: TransferUpdate) => {
    if (!win.isDestroyed()) win.webContents.send('transfer:updated', update)
  })

  // 큐가 만든 폴더도 탐색 캐시가 알아야 한다(ftp:mkdir이 내던 mutation과 같다)
  queue.on('dir:created', (remotePath: string) => {
    manager.emit('mutation', { kind: 'mkdir', remotePath })
  })

  ipcMain.handle('transfer:enqueue', (_event, payload: EnqueuePayload): IpcResult<string> => {
    try {
      const id = queue.enqueue(
        payload.direction,
        payload.localPath,
        payload.remotePath,
        payload.fileName,
        payload.totalBytes
      )
      return { success: true, data: id }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'transfer:enqueueBatch',
    (_event, payload: EnqueueBatchPayload): IpcResult<string[]> => {
      try {
        const ids = queue.enqueueBatch(
          payload.direction,
          payload.items,
          payload.forceBatch,
          payload.remoteDirs
        )
        return { success: true, data: ids }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  const planDeps: PlanDeps = {
    list: (dir) => manager.list(dir),
    collectFiles: (dir) => localFs.collectFiles(dir),
    platform: process.platform
  }

  // 보내기 계획은 상태 없이 매번 새로 세운다(D8). 결정 없는 충돌이 있으면 아무것도 넣지 않고 그 충돌만 돌려주고,
  // 렌더러가 결정을 모아 같은 요청을 다시 보낸다. 다운로드는 배타적이지 않다: 덮어쓰기 결정이 가능해야 한다(D12).
  ipcMain.handle(
    'transfer:send',
    async (_event, req: TransferSendRequest): Promise<IpcResult<TransferSendResult>> => {
      if (!manager.isConnected()) {
        return {
          success: false,
          error: 'Not connected to FTP server.',
          code: ErrorCode.FTP_NOT_CONNECTED
        }
      }
      try {
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
        return ipcError(err)
      }
    }
  )

  ipcMain.handle('transfer:retry', (_event, ids: string[]): IpcResult<void> => {
    try {
      queue.retry(ids)
      return { success: true, data: undefined }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('transfer:cancel', (_event, id: string): IpcResult<void> => {
    try {
      queue.cancel(id)
      return { success: true, data: undefined }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('transfer:clearCompleted', (): IpcResult<void> => {
    try {
      queue.clearCompleted()
      return { success: true, data: undefined }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('transfer:getAll', (): IpcResult<TransferJob[]> => {
    return { success: true, data: queue.getAll() }
  })

  return queue
}
