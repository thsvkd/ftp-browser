import { ipcMain, BrowserWindow } from 'electron'
import {
  sessionIpcError,
  type ConnectionRegistry,
  type FtpSession
} from '../ftp/ConnectionRegistry'
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
  recordRecentPath,
  saveServer,
  ServerSaveError
} from '../db/servers'
import { SavedPasswordUnreadableError, type PasswordVault } from '../db/passwordVault'
import { ipcError } from '../utils/errorClassifier'
import { parseConnKey } from '@shared/connKey'
import type {
  FtpConnectPayload,
  FtpConnectionState,
  FtpListResult,
  RemoteChangedEvent,
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

/**
 * 연결·저장 서버·원격 파일 채널. 원격 채널은 첫 인자가 연결 키(`conn`)이고 그 세션에서만 돈다(MC3).
 * 그 키가 연결돼 있지 않으면 FTP_NOT_CONNECTED, 키 형식이 틀리면 'Invalid connection key.'를 값으로 돌려준다.
 */
export function registerFtpHandlers(
  win: BrowserWindow,
  operationManager: OperationManager,
  passwords: PasswordVault,
  registry: ConnectionRegistry
): void {
  registry.on('connectionStatus', (state: FtpConnectionState) => {
    if (!win.isDestroyed()) win.webContents.send('ftp:connectionStatus', state)
  })
  // GUI가 시작한 것도 포함해 원격 변경을 알린다. 에이전트가 바꾼 폴더를 GUI가 새로 고친다(K5).
  registry.on('mutation', (changed: RemoteChangedEvent) => {
    if (!win.isDestroyed()) win.webContents.send('ftp:remoteChanged', changed)
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
        const result = await registry.connect(config)
        if (result.cancelled) {
          return { success: false, error: 'Connection cancelled' }
        }
        if (result.success) {
          // UPSERT server info (keyed on host+port)
          try {
            // 이미 있던 연결을 다시 썼으면 이 페이로드로 로그인하지 않았다(MC5). 확인되지 않은
            // 비밀번호·보안 설정은 저장하지 않고 그 주소의 연결 시각만 찍는다.
            if (result.reused) {
              recordConnection(getDatabase(), { ...config, id: undefined }, KEEP_PASSWORD)
              return { success: true, data: undefined }
            }
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

  // 연결 여부와 무관하게 그 연결 키의 기록만 읽는다(same-host-accounts SH10)
  ipcMain.handle('ftp:getRecentPaths', (_event, conn: unknown): IpcResult<RecentPath[]> => {
    if (typeof conn !== 'string' || parseConnKey(conn) === null) {
      return { success: false, error: 'Invalid connection key.' }
    }
    try {
      return { success: true, data: getRecentPaths(getDatabase(), conn) }
    } catch (err) {
      console.warn('[ftpHandlers] Failed to load recent paths:', err)
      return { success: true, data: [] }
    }
  })

  ipcMain.handle('ftp:disconnect', async (_event, conn: unknown): Promise<IpcResult<void>> => {
    try {
      if (typeof conn !== 'string' || parseConnKey(conn) === null) {
        return { success: false, error: 'Invalid connection key.' }
      }
      await registry.disconnect(conn)
      return { success: true, data: undefined }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle(
    'ftp:list',
    async (_event, conn: unknown, remotePath: string): Promise<IpcResult<FtpListResult>> => {
      try {
        const session = registry.require(conn)
        const result = await session.manager.list(remotePath)

        // 그 연결(사용자까지)의 최근 경로로 남긴다
        if (session.manager.isConnected()) {
          try {
            recordRecentPath(getDatabase(), session.key, remotePath)
          } catch (dbErr) {
            // Non-critical: listing still succeeds even if recent-path save fails
            console.warn('[ftpHandlers] Failed to save recent path:', dbErr)
          }
        }

        return { success: true, data: result }
      } catch (err) {
        return sessionIpcError(err)
      }
    }
  )

  // 알려진 모든 연결(끊긴 것 포함)
  ipcMain.handle('ftp:getStatus', (): IpcResult<FtpConnectionState[]> => {
    return { success: true, data: registry.states() }
  })

  ipcMain.handle(
    'ftp:deleteBatch',
    async (_event, conn: unknown, targets: DeleteTarget[]): Promise<IpcResult<void>> => {
      let session: FtpSession
      try {
        session = registry.require(conn)
      } catch (err) {
        return sessionIpcError(err)
      }
      const { fileOps } = session
      const items = {
        itemCount: targets.length,
        itemName: targets.length === 1 ? remoteBasename(targets[0].path) : undefined,
        server: session.key
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
    async (_event, conn: unknown, oldPath: string, newPath: string): Promise<IpcResult<void>> => {
      try {
        await registry.require(conn).fileOps.rename(oldPath, newPath)
        return { success: true, data: undefined }
      } catch (err) {
        return sessionIpcError(err)
      }
    }
  )

  ipcMain.handle(
    'ftp:mkdir',
    async (_event, conn: unknown, remotePath: string): Promise<IpcResult<void>> => {
      try {
        await registry.require(conn).fileOps.mkdir(remotePath)
        return { success: true, data: undefined }
      } catch (err) {
        return sessionIpcError(err)
      }
    }
  )
}
