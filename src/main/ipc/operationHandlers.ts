import { ipcMain, BrowserWindow } from 'electron'
import { OperationManager } from '../operation/OperationManager'
import { ipcError } from '../utils/errorClassifier'
import type { OperationJob, OperationProgress } from '@shared/types/operation'
import type { IpcResult } from '@shared/types/ipc'

/**
 * Creates the shared OperationManager, bridges its events to the renderer, and
 * registers the cancel/clear/list IPC handlers. The returned manager is passed
 * to the FS/FTP handlers so copy and delete operations can report progress.
 */
export function registerOperationHandlers(win: BrowserWindow): OperationManager {
  const manager = new OperationManager()

  manager.on('operation:updated', (jobs: OperationJob[]) => {
    win.webContents.send('operation:updated', jobs)
  })

  manager.on('operation:progress', (progress: OperationProgress) => {
    win.webContents.send('operation:progress', progress)
  })

  ipcMain.handle('operation:cancel', (_event, id: string): IpcResult<void> => {
    try {
      manager.requestCancel(id)
      return { success: true, data: undefined }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('operation:clearFinished', (): IpcResult<void> => {
    try {
      manager.clearFinished()
      return { success: true, data: undefined }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('operation:getAll', (): IpcResult<OperationJob[]> => {
    return { success: true, data: manager.getAll() }
  })

  return manager
}
