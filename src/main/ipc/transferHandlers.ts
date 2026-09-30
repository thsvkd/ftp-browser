import { ipcMain, BrowserWindow } from 'electron'
import { TransferQueue } from '../transfer/TransferQueue'
import { TransferClientPool } from '../transfer/TransferClientPool'
import { FtpFileOperations } from '../ftp/FtpFileOperations'
import { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import { ipcError } from '../utils/errorClassifier'
import type {
  TransferJob,
  TransferUpdate,
  TransferDirection,
  TransferEnqueueItem
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

export function registerTransferHandlers(
  win: BrowserWindow,
  fileOps: FtpFileOperations,
  manager: FtpConnectionManager
): TransferQueue {
  // 전송은 전용 연결 풀에서 돌아 메인 클라이언트(탐색)를 막지 않는다
  const queue = new TransferQueue(fileOps, new TransferClientPool(manager))

  queue.on('queue:updated', (update: TransferUpdate) => {
    win.webContents.send('transfer:updated', update)
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
