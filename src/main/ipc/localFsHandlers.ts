import { ipcMain, dialog, BrowserWindow } from 'electron'
import { stat, mkdir } from 'fs/promises'
import { basename, join, dirname } from 'path'
import { LocalFileSystem } from '../local/LocalFileSystem'
import { OperationManager } from '../operation/OperationManager'
import { ipcError } from '../utils/errorClassifier'
import type { LocalListResult } from '@shared/types/local'
import type { DeleteTarget } from '@shared/types/operation'
import type { IpcResult } from '@shared/types/ipc'

interface CopyWorkItem {
  src: string
  dest: string
  size: number
}

export function registerLocalFsHandlers(
  win: BrowserWindow,
  operationManager: OperationManager
): LocalFileSystem {
  const localFs = new LocalFileSystem()

  ipcMain.handle(
    'local:list',
    async (_event, dirPath: string): Promise<IpcResult<LocalListResult>> => {
      try {
        const result = await localFs.list(dirPath)
        return { success: true, data: result }
      } catch (err) {
        return ipcError(err)
      }
    }
  )

  ipcMain.handle('local:getHome', (): IpcResult<string> => {
    return { success: true, data: localFs.getHomePath() }
  })

  ipcMain.handle('local:selectDirectory', async (): Promise<IpcResult<string | null>> => {
    try {
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: true, data: null }
      }
      return { success: true, data: result.filePaths[0] }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('local:selectSaveDirectory', async (): Promise<IpcResult<string | null>> => {
    try {
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: true, data: null }
      }
      return { success: true, data: result.filePaths[0] }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle(
    'local:copyFiles',
    async (_event, sourcePaths: string[], destDir: string): Promise<IpcResult<void>> => {
      // Flatten sources (recursing into directories) into a file work list so
      // byte-based progress is uniform regardless of folder nesting.
      let work: CopyWorkItem[]
      try {
        work = []
        for (const src of sourcePaths) {
          const st = await stat(src)
          const name = basename(src)
          if (st.isDirectory()) {
            const inner = await localFs.collectFiles(src)
            for (const f of inner) {
              work.push({ src: f.abs, dest: join(destDir, name, f.rel), size: f.size })
            }
          } else {
            work.push({ src, dest: join(destDir, name), size: st.size })
          }
        }
      } catch (err) {
        return ipcError(err)
      }

      const totalBytes = work.reduce((sum, w) => sum + w.size, 0)
      const label =
        sourcePaths.length === 1
          ? `Copying ${basename(sourcePaths[0])}`
          : `Copying ${sourcePaths.length} items`
      const job = operationManager.create('copy', label, 'bytes', totalBytes)

      let copiedBytes = 0
      try {
        for (const item of work) {
          if (operationManager.isCancelled(job.id)) {
            operationManager.markCancelled(job.id)
            return { success: true, data: undefined }
          }
          await mkdir(dirname(item.dest), { recursive: true })
          await localFs.copyFileWithProgress(
            item.src,
            item.dest,
            (chunkLength) => {
              copiedBytes += chunkLength
              operationManager.progress(job.id, copiedBytes, basename(item.src))
            },
            () => operationManager.isCancelled(job.id)
          )
        }
        operationManager.complete(job.id)
        return { success: true, data: undefined }
      } catch (err) {
        if (operationManager.isCancelled(job.id)) {
          operationManager.markCancelled(job.id)
          return { success: true, data: undefined }
        }
        operationManager.fail(job.id, err instanceof Error ? err.message : String(err))
        return ipcError(err)
      }
    }
  )

  ipcMain.handle(
    'local:deleteBatch',
    async (_event, targets: DeleteTarget[]): Promise<IpcResult<void>> => {
      const label =
        targets.length === 1
          ? `Deleting ${basename(targets[0].path)}`
          : `Deleting ${targets.length} items`
      const job = operationManager.create('delete', label, 'files', targets.length)

      try {
        for (let i = 0; i < targets.length; i++) {
          if (operationManager.isCancelled(job.id)) {
            operationManager.markCancelled(job.id)
            return { success: true, data: undefined }
          }
          const target = targets[i]
          operationManager.progress(job.id, i, basename(target.path))
          await localFs.delete(target.path, target.isDirectory)
          operationManager.progress(job.id, i + 1, basename(target.path))
        }
        operationManager.complete(job.id)
        return { success: true, data: undefined }
      } catch (err) {
        operationManager.fail(job.id, err instanceof Error ? err.message : String(err))
        return ipcError(err)
      }
    }
  )

  return localFs
}
