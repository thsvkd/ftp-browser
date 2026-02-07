import { ipcMain, BrowserWindow } from 'electron'
import { TransferQueue } from '../transfer/TransferQueue'
import { FtpFileOperations } from '../ftp/FtpFileOperations'
import type { TransferJob, TransferProgress, TransferDirection } from '@shared/types/transfer'
import type { IpcResult } from '@shared/types/ipc'

interface EnqueuePayload {
  direction: TransferDirection
  localPath: string
  remotePath: string
  fileName: string
  totalBytes: number
}

export function registerTransferHandlers(
  win: BrowserWindow,
  fileOps: FtpFileOperations
): TransferQueue {
  const queue = new TransferQueue(fileOps)

  queue.on('queue:updated', (jobs: TransferJob[]) => {
    win.webContents.send('transfer:updated', jobs)
  })

  queue.on('transfer:progress', (progress: TransferProgress) => {
    win.webContents.send('transfer:progress', progress)
  })

  ipcMain.handle(
    'transfer:enqueue',
    (_event, payload: EnqueuePayload): IpcResult<string> => {
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
    }
  )

  ipcMain.handle('transfer:cancel', (_event, id: string): IpcResult<void> => {
    try {
      queue.cancel(id)
      return { success: true, data: undefined }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('transfer:clearCompleted', (): IpcResult<void> => {
    try {
      queue.clearCompleted()
      return { success: true, data: undefined }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('transfer:getAll', (): IpcResult<TransferJob[]> => {
    return { success: true, data: queue.getAll() }
  })

  return queue
}
