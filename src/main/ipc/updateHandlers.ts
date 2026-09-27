import { ipcMain } from 'electron'
import type { IpcResult } from '@shared/types/ipc'
import type { UpdateState } from '@shared/types/update'
import type { UpdateManager } from '../update/UpdateManager'

export function registerUpdateHandlers(
  manager: UpdateManager,
  persistAutoUpdate: (enabled: boolean) => void
): void {
  ipcMain.handle(
    'update:getState',
    async (): Promise<IpcResult<UpdateState>> => ({
      success: true,
      data: manager.getState()
    })
  )
  ipcMain.handle(
    'update:check',
    async (): Promise<IpcResult<UpdateState>> => ({
      success: true,
      data: await manager.check()
    })
  )
  ipcMain.handle(
    'update:download',
    async (): Promise<IpcResult<UpdateState>> => ({
      success: true,
      data: await manager.download()
    })
  )
  ipcMain.handle(
    'update:setAutoUpdate',
    async (_event, enabled: boolean): Promise<IpcResult<UpdateState>> => {
      persistAutoUpdate(enabled)
      return { success: true, data: await manager.setAutoUpdate(enabled) }
    }
  )
  ipcMain.handle('update:install', async (): Promise<IpcResult<void>> => {
    manager.install()
    return { success: true, data: undefined }
  })
}
