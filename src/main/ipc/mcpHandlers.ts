import { ipcMain } from 'electron'
import type { IpcResult } from '@shared/types/ipc'
import type { McpState } from '@shared/types/mcp'
import type { McpService } from '../mcp/McpService'

export function registerMcpHandlers(service: McpService): void {
  ipcMain.handle(
    'mcp:getState',
    (): IpcResult<McpState> => ({ success: true, data: service.getState() })
  )
  ipcMain.handle(
    'mcp:setEnabled',
    async (_event, enabled: boolean): Promise<IpcResult<McpState>> => ({
      success: true,
      data: await service.setEnabled(enabled)
    })
  )
  ipcMain.handle(
    'mcp:regenerateToken',
    (): IpcResult<McpState> => ({ success: true, data: service.regenerateToken() })
  )
}
