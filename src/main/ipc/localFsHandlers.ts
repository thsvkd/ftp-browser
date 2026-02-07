import { ipcMain, dialog, BrowserWindow } from 'electron'
import { LocalFileSystem } from '../local/LocalFileSystem'
import type { LocalListResult } from '@shared/types/local'
import type { IpcResult } from '@shared/types/ipc'

export function registerLocalFsHandlers(win: BrowserWindow): LocalFileSystem {
  const localFs = new LocalFileSystem()

  ipcMain.handle(
    'local:list',
    async (_event, dirPath: string): Promise<IpcResult<LocalListResult>> => {
      try {
        const result = await localFs.list(dirPath)
        return { success: true, data: result }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('local:getHome', (): IpcResult<string> => {
    return { success: true, data: localFs.getHomePath() }
  })

  ipcMain.handle(
    'local:selectDirectory',
    async (): Promise<IpcResult<string | null>> => {
      try {
        const result = await dialog.showOpenDialog(win, {
          properties: ['openDirectory']
        })
        if (result.canceled || result.filePaths.length === 0) {
          return { success: true, data: null }
        }
        return { success: true, data: result.filePaths[0] }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'local:selectSaveDirectory',
    async (): Promise<IpcResult<string | null>> => {
      try {
        const result = await dialog.showOpenDialog(win, {
          properties: ['openDirectory', 'createDirectory']
        })
        if (result.canceled || result.filePaths.length === 0) {
          return { success: true, data: null }
        }
        return { success: true, data: result.filePaths[0] }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  return localFs
}
