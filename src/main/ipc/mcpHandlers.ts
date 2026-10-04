import { ipcMain } from 'electron'
import type { IpcResult } from '@shared/types/ipc'
import type { McpState } from '@shared/types/mcp'
import type { McpService } from '../mcp/McpService'
import { ipcError } from '../utils/errorClassifier'

export function registerMcpHandlers(service: McpService): void {
  ipcMain.handle('mcp:getState', (): IpcResult<McpState> => {
    try {
      return { success: true, data: service.getState() }
    } catch (err) {
      return ipcError(err)
    }
  })
  ipcMain.handle(
    'mcp:setEnabled',
    async (_event, enabled: boolean): Promise<IpcResult<McpState>> => {
      try {
        return { success: true, data: await service.setEnabled(enabled) }
      } catch (err) {
        return ipcError(err)
      }
    }
  )
  ipcMain.handle('mcp:regenerateToken', (): IpcResult<McpState> => {
    try {
      return { success: true, data: service.regenerateToken() }
    } catch (err) {
      return ipcError(err)
    }
  })
}
