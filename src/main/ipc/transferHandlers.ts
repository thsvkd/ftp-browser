import { ipcMain, BrowserWindow } from 'electron'
import { mkdir } from 'fs/promises'
import { TransferQueue } from '../transfer/TransferQueue'
import { TransferClientPool } from '../transfer/TransferClientPool'
import { planDownload, planUpload, resolvePlan, type PlanDeps } from '../transfer/folderPlan'
import { FtpFileOperations } from '../ftp/FtpFileOperations'
import { FtpSessionRegistry } from '../ftp/FtpSessionRegistry'
import { LocalFileSystem } from '../local/LocalFileSystem'
import { ipcError } from '../utils/errorClassifier'
import type {
  TransferJob,
  TransferUpdate,
  TransferDirection,
  TransferEnqueueItem,
  TransferSendRequest,
  TransferSendResult
} from '@shared/types/transfer'
import { ErrorCode, type IpcResult } from '@shared/types/ipc'

interface EnqueuePayload {
  direction: TransferDirection
  localPath: string
  remotePath: string
  fileName: string
  totalBytes: number
}

interface EnqueueBatchPayload {
  direction: TransferDirection
  items: TransferEnqueueItem[]
  forceBatch?: boolean
  /** 업로드 전에 만들어야 하는 원격 디렉터리(중간 경로 포함) */
  remoteDirs?: string[]
}

export function registerTransferHandlers(
  win: BrowserWindow,
  fileOps: FtpFileOperations,
  registry: FtpSessionRegistry,
  localFs: LocalFileSystem
): TransferQueue {
  // 전송은 전용 연결 풀에서 돌아 메인 클라이언트(탐색)를 막지 않는다. 세션마다 큐·풀 하나(A′2):
  // 인자를 생략하면 primary 세션의 큐다(M3) — MCP·기존 호출부가 쓰는 경로다(M9).
  const queues = new Map<string, TransferQueue>()
  /** 작업 id → 그 작업을 넣은 큐. cancel·retry를 작업이 속은 큐로 보낸다(A′2). */
  const jobQueues = new Map<string, TransferQueue>()

  /** 큐의 변경분을 세션 태그(M5)와 함께 창으로 보내고, 큐가 만든 폴더를 탐색 캐시에 알린다. */
  const wire = (queue: TransferQueue, server?: string): void => {
    queue.on('queue:updated', (update: TransferUpdate) => {
      for (const id of update.removedIds) jobQueues.delete(id)
      if (!win.isDestroyed())
        win.webContents.send('transfer:updated', {
          ...update,
          server: registry.keyOf(registry.get(server))
        })
    })
    // 큐가 만든 폴더도 탐색 캐시가 알아야 한다(ftp:mkdir이 내던 mutation과 같다)
    queue.on('dir:created', (remotePath: string) => {
      const key = registry.keyOf(registry.get(server))
      registry.emit('mutation', {
        kind: 'mkdir',
        remotePath,
        ...(key !== undefined ? { server: key } : {})
      })
    })
  }

  /** 그 세션의 큐(없으면 만든다). 인자를 생략하면 primary(A′2·M3). */
  const queueFor = (server?: string): TransferQueue => {
    const key = server ?? ''
    const existing = queues.get(key)
    if (existing) return existing
    // primary 큐는 핸들러에 들어온 fileOps(위임)를 그대로 쓰고, 세션 큐는 그 세션의 매니저로 만든다.
    const queue =
      key === ''
        ? new TransferQueue(fileOps, new TransferClientPool(registry))
        : new TransferQueue(
            new FtpFileOperations(registry.get(server)),
            new TransferClientPool(registry.get(server))
          )
    wire(queue, server)
    queues.set(key, queue)
    return queue
  }
  const queue = queueFor()

  /** enqueue로 생긴 작업이 어느 큐의 것인지 기억한다(cancel·retry 라우팅, A′2). */
  const remember = (target: TransferQueue, ids: string[]): void => {
    for (const id of ids) jobQueues.set(id, target)
  }

  ipcMain.handle(
    'transfer:enqueue',
    (_event, payload: EnqueuePayload, server?: string): IpcResult<string> => {
      try {
        const target = queueFor(server)
        const id = target.enqueue(
          payload.direction,
          payload.localPath,
          payload.remotePath,
          payload.fileName,
          payload.totalBytes
        )
        remember(target, [id])
        return { success: true, data: id }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'transfer:enqueueBatch',
    (_event, payload: EnqueueBatchPayload, server?: string): IpcResult<string[]> => {
      try {
        const target = queueFor(server)
        const ids = target.enqueueBatch(
          payload.direction,
          payload.items,
          payload.forceBatch,
          payload.remoteDirs
        )
        remember(target, ids)
        return { success: true, data: ids }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // 보내기 계획은 상태 없이 매번 새로 세운다(D8). 결정 없는 충돌이 있으면 아무것도 넣지 않고 그 충돌만 돌려주고,
  // 렌더러가 결정을 모아 같은 요청을 다시 보낸다. 다운로드는 배타적이지 않다: 덮어쓰기 결정이 가능해야 한다(D12).
  ipcMain.handle(
    'transfer:send',
    async (
      _event,
      req: TransferSendRequest,
      server?: string
    ): Promise<IpcResult<TransferSendResult>> => {
      // 함정 B: 계획의 목록과 연결 확인은 모두 그 세션의 매니저로 한다(M4). 인자를 생략하면 primary(M3).
      const session = registry.get(server)
      if (!session.isConnected()) {
        return {
          success: false,
          error: 'Not connected to FTP server.',
          code: ErrorCode.FTP_NOT_CONNECTED
        }
      }
      const planDeps: PlanDeps = {
        list: (dir) => session.list(dir),
        collectFiles: (dir) => localFs.collectFiles(dir),
        platform: process.platform
      }
      try {
        const upload = req.direction === 'upload'
        const plan = upload
          ? await planUpload(planDeps, req.sources, req.destDir)
          : await planDownload(planDeps, req.sources, req.destDir)
        const { items, skipped, unresolved, totalBytes } = resolvePlan(
          plan,
          (c) => req.decisions?.[c.target]
        )
        if (unresolved.length > 0) {
          return { success: true, data: { ids: [], skipped, conflicts: unresolved, totalBytes } }
        }
        // 다운로드가 만들 로컬 폴더는 큐에 넣기 직전에만 만든다
        if (!upload) for (const dir of plan.dirs) await mkdir(dir, { recursive: true })
        // 실행도 그 세션의 큐·풀로 보낸다(A′2): 다른 서버로 파일이 올라가지 않는다.
        const target = queueFor(server)
        const ids = target.enqueueBatch(req.direction, items, true, upload ? plan.dirs : undefined)
        remember(target, ids)
        const batchId = target.getAll().find((job) => job.id === ids[0])?.batchId
        return { success: true, data: { batchId, ids, skipped, conflicts: [], totalBytes } }
      } catch (err) {
        return ipcError(err)
      }
    }
  )

  ipcMain.handle('transfer:retry', (_event, ids: string[]): IpcResult<void> => {
    try {
      // 작업이 속은 큐로 보낸다. 모르는 id는(기존과 같게) primary 큐가 무시한다(A′2·M3).
      const groups = new Map<TransferQueue, string[]>()
      for (const id of ids) {
        const target = jobQueues.get(id) ?? queue
        const group = groups.get(target)
        if (group) group.push(id)
        else groups.set(target, [id])
      }
      for (const [target, group] of groups) target.retry(group)
      return { success: true, data: undefined }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('transfer:cancel', (_event, id: string): IpcResult<void> => {
    try {
      // cancel은 작업 id만으로 그 작업이 속은 큐에서 취소한다(A′2).
      ;(jobQueues.get(id) ?? queue).cancel(id)
      return { success: true, data: undefined }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('transfer:clearCompleted', (): IpcResult<void> => {
    try {
      for (const q of queues.values()) q.clearCompleted()
      return { success: true, data: undefined }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('transfer:getAll', (): IpcResult<TransferJob[]> => {
    // 활동 UI는 모든 세션의 작업을 하나로 모아 본다(A′2).
    return { success: true, data: [...queues.values()].flatMap((q) => q.getAll()) }
  })

  return queue
}
