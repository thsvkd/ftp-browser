import { ipcMain, BrowserWindow } from 'electron'
import { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import { FtpFileOperations } from '../ftp/FtpFileOperations'
import { getDatabase } from '../db/database'
import { ipcError } from '../utils/errorClassifier'
import type {
  FtpConnectPayload,
  FtpConnectionState,
  FtpListResult,
  FtpServer,
  RecentPath
} from '@shared/types/ftp'
import type { IpcResult } from '@shared/types/ipc'

export interface FtpHandlersResult {
  manager: FtpConnectionManager
  fileOps: FtpFileOperations
}

export function registerFtpHandlers(win: BrowserWindow): FtpHandlersResult {
  const manager = new FtpConnectionManager()
  const fileOps = new FtpFileOperations(manager)

  manager.on('connectionStatus', (state: FtpConnectionState) => {
    win.webContents.send('ftp:connectionStatus', state)
  })

  ipcMain.handle(
    'ftp:connect',
    async (_event, payload: FtpConnectPayload): Promise<IpcResult<void>> => {
      try {
        const result = await manager.connect(payload)
        if (result.success) {
          // UPSERT server info (keyed on host+port)
          try {
            const db = getDatabase()
            db.prepare(
              `INSERT INTO servers (name, host, port, username, password_enc, secure, last_connected)
               VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(host, port) DO UPDATE SET
                 username = excluded.username,
                 password_enc = excluded.password_enc,
                 secure = excluded.secure,
                 last_connected = datetime('now')`
            ).run(
              payload.host,
              payload.host,
              payload.port,
              payload.user,
              payload.password,
              payload.secure ? 1 : 0
            )
          } catch (dbErr) {
            // Non-critical: don't fail the connection if DB save fails
            console.warn('[ftpHandlers] Failed to persist server info:', dbErr)
          }
          return { success: true, data: undefined }
        }
        return { success: false, error: result.error ?? 'Connection failed' }
      } catch (err) {
        return ipcError(err)
      }
    }
  )

  ipcMain.handle('ftp:getLastServer', (): IpcResult<FtpServer | null> => {
    try {
      const db = getDatabase()
      const row = db
        .prepare(
          'SELECT host, port, username, password_enc, secure FROM servers ORDER BY last_connected DESC LIMIT 1'
        )
        .get() as
        | { host: string; port: number; username: string; password_enc: string; secure: number }
        | undefined
      if (!row) return { success: true, data: null }
      return {
        success: true,
        data: {
          name: row.host,
          host: row.host,
          port: row.port,
          username: row.username || '',
          password: row.password_enc || '',
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
      const db = getDatabase()
      const rows = db
        .prepare(
          'SELECT id, host, port, username, password_enc, secure, last_connected FROM servers ORDER BY last_connected DESC LIMIT 20'
        )
        .all() as Array<{
        id: number
        host: string
        port: number
        username: string
        password_enc: string
        secure: number
        last_connected: string
      }>
      const servers: FtpServer[] = rows.map((r) => ({
        id: r.id,
        name: r.host,
        host: r.host,
        port: r.port,
        username: r.username || '',
        password: r.password_enc || '',
        secure: r.secure === 1,
        lastConnected: r.last_connected
      }))
      return { success: true, data: servers }
    } catch (err) {
      console.warn('[ftpHandlers] Failed to load recent servers:', err)
      return { success: true, data: [] }
    }
  })

  ipcMain.handle('ftp:deleteServer', (_event, serverId: number): IpcResult<void> => {
    try {
      const db = getDatabase()
      // Delete server and its recent paths
      const row = db.prepare('SELECT host, port FROM servers WHERE id = ?').get(serverId) as
        | { host: string; port: number }
        | undefined
      if (row) {
        db.prepare('DELETE FROM server_recent_paths WHERE server_host = ? AND server_port = ?').run(
          row.host,
          row.port
        )
      }
      db.prepare('DELETE FROM servers WHERE id = ?').run(serverId)
      return { success: true, data: undefined }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle(
    'ftp:getRecentPaths',
    (_event, host: string, port: number): IpcResult<RecentPath[]> => {
      try {
        const db = getDatabase()
        const rows = db
          .prepare(
            'SELECT path, last_visited FROM server_recent_paths WHERE server_host = ? AND server_port = ? ORDER BY last_visited DESC LIMIT 20'
          )
          .all(host, port) as Array<{ path: string; last_visited: string }>
        return {
          success: true,
          data: rows.map((r) => ({ path: r.path, lastVisited: r.last_visited }))
        }
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
            db.prepare(
              `INSERT INTO server_recent_paths (server_host, server_port, path, last_visited)
               VALUES (?, ?, ?, datetime('now'))
               ON CONFLICT(server_host, server_port, path) DO UPDATE SET last_visited = datetime('now')`
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
    'ftp:delete',
    async (_event, remotePath: string, isDirectory: boolean): Promise<IpcResult<void>> => {
      try {
        if (isDirectory) {
          await fileOps.deleteDirectory(remotePath)
        } else {
          await fileOps.deleteFile(remotePath)
        }
        return { success: true, data: undefined }
      } catch (err) {
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
