import { ipcMain, BrowserWindow } from 'electron'
import { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import { FtpFileOperations } from '../ftp/FtpFileOperations'
import { OperationManager } from '../operation/OperationManager'
import { getDatabase } from '../db/database'
import {
  deleteServer,
  getRecentPaths,
  HAS_PASSWORD_SQL,
  isSavedAddress,
  isSavedLogin,
  KEEP_PASSWORD,
  listServers,
  recordConnection,
  saveServer,
  ServerSaveError
} from '../db/servers'
import { SavedPasswordUnreadableError, type PasswordVault } from '../db/passwordVault'
import { ipcError } from '../utils/errorClassifier'
import type {
  FtpConnectPayload,
  FtpConnectionState,
  FtpListResult,
  FtpServer,
  FtpServerInput,
  PasswordProtection,
  RecentPath
} from '@shared/types/ftp'
import type { DeleteTarget } from '@shared/types/operation'
import type { IpcResult } from '@shared/types/ipc'

/** Basename of a POSIX remote path (FTP paths always use forward slashes). */
function remoteBasename(remotePath: string): string {
  const parts = remotePath.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : remotePath
}

export interface FtpHandlersResult {
  manager: FtpConnectionManager
  fileOps: FtpFileOperations
}

export function registerFtpHandlers(
  win: BrowserWindow,
  operationManager: OperationManager,
  passwords: PasswordVault
): FtpHandlersResult {
  const manager = new FtpConnectionManager()
  const fileOps = new FtpFileOperations(manager)

  manager.on('connectionStatus', (state: FtpConnectionState) => {
    if (!win.isDestroyed()) win.webContents.send('ftp:connectionStatus', state)
  })

  ipcMain.handle(
    'ftp:connect',
    async (_event, payload: FtpConnectPayload): Promise<IpcResult<void>> => {
      try {
        // 입력한 비밀번호가 없으면 저장된 비밀번호를 main이 직접 읽는다. 렌더러는 그 값을 모른다(E8).
        // 풀 수 없으면 연결을 시도하지 않는다(E5).
        const { savedPasswordOf, ...login } = payload
        // 저장된 비밀번호는 저장한 서버의 주소·계정에만 보내고, 갱신할 서버(id)도 그 서버여야 한다(E15).
        // GUI는 이런 요청을 보내지 않는다. 연결도 저장도 하지 않는다.
        if (
          savedPasswordOf !== undefined &&
          ((login.id !== undefined && login.id !== savedPasswordOf) ||
            !isSavedLogin(getDatabase(), savedPasswordOf, login))
        ) {
          return {
            success: false,
            error:
              'The saved password can only be used for the server it was saved for. Enter the password.'
          }
        }
        const usesSaved = login.password === undefined && savedPasswordOf !== undefined
        const password = usesSaved ? await passwords.reveal(savedPasswordOf) : login.password
        const config: FtpConnectPayload = { ...login, password: password || 'anonymous@' }
        const result = await manager.connect(config)
        if (result.cancelled) {
          return { success: false, error: 'Connection cancelled' }
        }
        if (result.success) {
          // UPSERT server info (keyed on host+port)
          try {
            // 갱신하는 서버의 저장된 비밀번호로 연결했으면 그대로 두고, 아니면 로그인한 비밀번호를
            // 암호화해 저장한다(E8). 암호화도 저장의 일부라 실패해도 연결은 성공이다.
            const write =
              usesSaved && login.id === savedPasswordOf
                ? KEEP_PASSWORD
                : await passwords.toWrite(config.password)
            // 다른 주소로 접속하면서 저장된 서버(id)를 가리켜도 그 서버의 로그인은 바꾸지 않는다.
            // 그때는 접속한 주소로만 기록한다(E15).
            const updates =
              config.id !== undefined && isSavedAddress(getDatabase(), config.id, config)
            recordConnection(getDatabase(), updates ? config : { ...config, id: undefined }, write)
          } catch (dbErr) {
            // Non-critical: don't fail the connection if DB save fails
            console.warn('[ftpHandlers] Failed to persist server info:', dbErr)
          }
          return { success: true, data: undefined }
        }
        return { success: false, error: result.error ?? 'Connection failed' }
      } catch (err) {
        if (err instanceof SavedPasswordUnreadableError) {
          return { success: false, error: err.message, code: err.code }
        }
        return ipcError(err)
      }
    }
  )

  ipcMain.handle('ftp:getLastServer', (): IpcResult<FtpServer | null> => {
    try {
      const db = getDatabase()
      const row = db
        .prepare(
          `SELECT host, port, username, ${HAS_PASSWORD_SQL} AS has_password, secure FROM servers ORDER BY last_connected DESC LIMIT 1`
        )
        .get() as
        | { host: string; port: number; username: string; has_password: number; secure: number }
        | undefined
      if (!row) return { success: true, data: null }
      return {
        success: true,
        data: {
          name: row.host,
          host: row.host,
          port: row.port,
          username: row.username || '',
          hasPassword: row.has_password === 1,
          secure: row.secure === 1
        }
      }
    } catch (err) {
      console.warn('[ftpHandlers] Failed to load last server:', err)
      return { success: true, data: null }
    }
  })

  ipcMain.handle('ftp:getRecentServers', (): IpcResult<FtpServer[]> => {
    try {
      return { success: true, data: listServers(getDatabase()) }
    } catch (err) {
      console.warn('[ftpHandlers] Failed to load recent servers:', err)
      return { success: true, data: [] }
    }
  })

  ipcMain.handle(
    'ftp:saveServer',
    async (_event, input: FtpServerInput): Promise<IpcResult<FtpServer>> => {
      try {
        // undefined는 유지, ''는 삭제, 값은 교체(E9). 암호화는 DB 트랜잭션 전에 끝낸다(E3).
        const write = await passwords.toWrite(input.password)
        return { success: true, data: saveServer(getDatabase(), input, write) }
      } catch (err) {
        if (err instanceof ServerSaveError) {
          return { success: false, error: err.message, code: err.code }
        }
        return ipcError(err)
      }
    }
  )

  ipcMain.handle('ftp:getPasswordProtection', async (): Promise<IpcResult<PasswordProtection>> => {
    try {
      return { success: true, data: await passwords.protection() }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('ftp:deleteServer', (_event, serverId: number): IpcResult<void> => {
    try {
      deleteServer(getDatabase(), serverId)
      return { success: true, data: undefined }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle(
    'ftp:getRecentPaths',
    (_event, host: string, port: number): IpcResult<RecentPath[]> => {
      try {
        return { success: true, data: getRecentPaths(getDatabase(), host, port) }
      } catch (err) {
        console.warn('[ftpHandlers] Failed to load recent paths:', err)
        return { success: true, data: [] }
      }
    }
  )

  ipcMain.handle('ftp:disconnect', async (): Promise<IpcResult<void>> => {
    try {
      await manager.disconnect()
      return { success: true, data: undefined }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle(
    'ftp:list',
    async (_event, remotePath: string): Promise<IpcResult<FtpListResult>> => {
      try {
        const result = await manager.list(remotePath)

        // Save recent path for current server
        if (manager.isConnected()) {
          try {
            const db = getDatabase()
            const host = manager.getHost()
            const port = manager.getPort()
            // 밀리초까지 찍는다. 다시 연결할 때 가장 최근 경로에서 여는데, 1초 안에
            // 폴더를 여러 번 옮기면 초 단위로는 어느 것이 마지막인지 가릴 수 없다.
            db.prepare(
              `INSERT INTO server_recent_paths (server_host, server_port, path, last_visited)
               VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))
               ON CONFLICT(server_host, server_port, path)
               DO UPDATE SET last_visited = excluded.last_visited`
            ).run(host, port, remotePath)

            // Keep only last 20 paths per server
            db.prepare(
              `DELETE FROM server_recent_paths
               WHERE server_host = ? AND server_port = ?
               AND id NOT IN (
                 SELECT id FROM server_recent_paths
                 WHERE server_host = ? AND server_port = ?
                 ORDER BY last_visited DESC LIMIT 20
               )`
            ).run(host, port, host, port)
          } catch (dbErr) {
            // Non-critical: listing still succeeds even if recent-path save fails
            console.warn('[ftpHandlers] Failed to save recent path:', dbErr)
          }
        }

        return { success: true, data: result }
      } catch (err) {
        return ipcError(err)
      }
    }
  )

  ipcMain.handle('ftp:getStatus', (): IpcResult<FtpConnectionState> => {
    return {
      success: true,
      data: {
        status: manager.isConnected() ? 'connected' : 'disconnected',
        host: manager.getHost()
      }
    }
  })

  ipcMain.handle(
    'ftp:deleteBatch',
    async (_event, targets: DeleteTarget[]): Promise<IpcResult<void>> => {
      const items = {
        itemCount: targets.length,
        itemName: targets.length === 1 ? remoteBasename(targets[0].path) : undefined
      }
      const job = operationManager.create('delete', items, 'files', targets.length)

      try {
        // 진행률 단위는 지워진 항목(파일+폴더) 수다. 아직 LIST하지 않은 대상은 1개로 세고,
        // 폴더를 LIST한 뒤에 그 폴더의 실제 항목 수로 total을 늘린다.
        let done = 0
        for (let i = 0; i < targets.length; i++) {
          if (operationManager.isCancelled(job.id)) {
            operationManager.markCancelled(job.id)
            return { success: true, data: undefined }
          }
          const target = targets[i]
          const rest = targets.length - i - 1
          operationManager.progress(job.id, done, remoteBasename(target.path), done + 1 + rest)
          if (target.isDirectory) {
            let removed = 0
            await fileOps.deleteDirectory(target.path, (n, total, path) => {
              removed = n
              operationManager.progress(job.id, done + n, remoteBasename(path), done + total + rest)
            })
            done += removed
          } else {
            await fileOps.deleteFile(target.path)
            done += 1
          }
          operationManager.progress(job.id, done, remoteBasename(target.path), done + rest)
        }
        operationManager.complete(job.id)
        return { success: true, data: undefined }
      } catch (err) {
        operationManager.fail(job.id, err instanceof Error ? err.message : String(err))
        return ipcError(err)
      }
    }
  )

  ipcMain.handle(
    'ftp:rename',
    async (_event, oldPath: string, newPath: string): Promise<IpcResult<void>> => {
      try {
        await fileOps.rename(oldPath, newPath)
        return { success: true, data: undefined }
      } catch (err) {
        return ipcError(err)
      }
    }
  )

  ipcMain.handle('ftp:mkdir', async (_event, remotePath: string): Promise<IpcResult<void>> => {
    try {
      await fileOps.mkdir(remotePath)
      return { success: true, data: undefined }
    } catch (err) {
      return ipcError(err)
    }
  })

  return { manager, fileOps }
}
