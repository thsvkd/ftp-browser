import path from 'path'
import { ipcMain } from 'electron'
import type { IpcResult } from '@shared/types/ipc'
import type { McpState } from '@shared/types/mcp'
import type { McpService } from '../mcp/McpService'
import { ipcError } from '../utils/errorClassifier'

/** out/main 옆의 out/cli/ftpb.cjs. 패키징된 앱에서는 asar 밖(app.asar.unpacked)에 풀려 있다. */
export function bundledCliPath(mainDir: string): string {
  return path
    .join(mainDir, '..', 'cli', 'ftpb.cjs')
    .replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked')
}

/**
 * `ftpb`를 앱 실행 파일의 Node 모드로 돌리는 셸 명령(K7). Windows는 PowerShell, 그 밖은 POSIX 셸이다.
 * 경로는 작은따옴표로 감싼다. 토큰은 담지 않는다(CLI가 발견 파일에서 읽는다).
 */
export function buildCliCommand(platform: string, execPath: string, cliPath: string): string {
  if (platform === 'win32') {
    const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`
    return `$env:ELECTRON_RUN_AS_NODE=1; & ${quote(execPath)} ${quote(cliPath)}`
  }
  const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  return `ELECTRON_RUN_AS_NODE=1 ${quote(execPath)} ${quote(cliPath)}`
}

export function registerMcpHandlers(service: McpService, cliCommand: string): void {
  const withCli = (state: McpState): McpState => ({ ...state, cliCommand })
  ipcMain.handle('mcp:getState', (): IpcResult<McpState> => {
    try {
      return { success: true, data: withCli(service.getState()) }
    } catch (err) {
      return ipcError(err)
    }
  })
  ipcMain.handle(
    'mcp:setEnabled',
    async (_event, enabled: boolean): Promise<IpcResult<McpState>> => {
      try {
        return { success: true, data: withCli(await service.setEnabled(enabled)) }
      } catch (err) {
        return ipcError(err)
      }
    }
  )
  ipcMain.handle('mcp:regenerateToken', (): IpcResult<McpState> => {
    try {
      return { success: true, data: withCli(service.regenerateToken()) }
    } catch (err) {
      return ipcError(err)
    }
  })
}
