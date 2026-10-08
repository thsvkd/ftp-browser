import type { OperationJob } from '@shared/types/operation'
import type { TransferJob, TransferUpdate } from '@shared/types/transfer'
import type { OperationManager } from '../operation/OperationManager'
import type { TransferQueue } from '../transfer/TransferQueue'

/** 에이전트가 기다리는 전송, 파일 작업(삭제) 또는 한 번에 넣은 전송 묶음(TransferJob.batchId) */
export interface JobSnapshot {
  id: string
  kind: 'transfer' | 'operation' | 'batch'
  /** pending, active, completed, failed, cancelled 또는 모르는 id면 unknown */
  status: string
  /** 더는 바뀌지 않는다 */
  done: boolean
  name: string
  transferredBytes?: number
  totalBytes?: number
  /** 작업은 지운 항목 수, 묶음은 끝난 전송 수 */
  completed?: number
  total?: number
  error?: string
}

export interface JobTracker {
  /** 모든 id가 끝나거나 `timeoutMs`가 지나면 그때의 상태를 돌려준다. 모르는 id는 unknown·done이다. */
  wait(ids: string[], timeoutMs: number): Promise<JobSnapshot[]>
}

/** EventEmitter 중 트래커가 구독하는 알림 하나 */
interface Listenable<E extends string, T> {
  on(event: E, listener: (payload: T) => void): unknown
  off(event: E, listener: (payload: T) => void): unknown
}

/** 기억하는 끝난 작업 수(종류마다). 오래된 것부터 잊는다. */
const REMEMBERED = 20_000

const isDone = (status: string): boolean => status !== 'pending' && status !== 'active'

function transferView(j: TransferJob): JobSnapshot {
  const { id, status, transferredBytes, totalBytes, error } = j
  const done = isDone(status)
  return {
    id,
    kind: 'transfer',
    status,
    done,
    name: j.fileName,
    transferredBytes,
    totalBytes,
    error
  }
}

function operationView(j: OperationJob): JobSnapshot {
  const { id, status, completed, total, error } = j
  const name = j.itemName ?? `${j.kind} ${j.itemCount} items`
  return { id, kind: 'operation', status, done: isDone(status), name, completed, total, error }
}

/** 묶음은 소속 전송을 하나로 요약한다. 끝났으면 하나라도 실패하면 failed, 취소되면 cancelled다. */
function batchView(id: string, jobs: TransferJob[]): JobSnapshot {
  const has = (status: string): boolean => jobs.some((j) => j.status === status)
  const sum = (key: 'transferredBytes' | 'totalBytes'): number =>
    jobs.reduce((total, j) => total + j[key], 0)
  const completed = jobs.filter((j) => isDone(j.status)).length
  const done = completed === jobs.length
  const failed = jobs.filter((j) => j.status === 'failed')
  return {
    id,
    kind: 'batch',
    status: done
      ? (['failed', 'cancelled'].find(has) ?? 'completed')
      : has('active')
        ? 'active'
        : 'pending',
    done,
    name: `${jobs.length} transfers`,
    completed,
    total: jobs.length,
    transferredBytes: sum('transferredBytes'),
    totalBytes: sum('totalBytes'),
    error: failed[0] && `${failed.length} failed; first: ${failed[0].error ?? 'unknown error'}`
  }
}

/**
 * 끝난 전송·파일 작업을 기억해 기다리게 한다. OperationManager는 끝난 작업을 5초 뒤 지우고 사용자는 전송
 * 목록을 비울 수 있어, 기억하지 않으면 늦게 기다린 에이전트가 결과 대신 unknown을 받는다.
 * 알림을 구독하므로 앱에 하나만 만든다. 폴링하지 않고 큐·작업 알림마다 다시 본다.
 */
export function createJobTracker(
  queue: Pick<TransferQueue, 'getAll'> & Listenable<'queue:updated', TransferUpdate>,
  operations: Pick<OperationManager, 'getAll'> & Listenable<'operation:updated', OperationJob[]>
): JobTracker {
  const transfers = new Map<string, TransferJob>()
  const ops = new Map<string, OperationJob>()
  const remember = <J extends { id: string; status: string }>(
    map: Map<string, J>,
    job: J
  ): void => {
    if (!isDone(job.status)) return
    map.delete(job.id)
    map.set(job.id, { ...job })
    if (map.size > REMEMBERED) map.delete(map.keys().next().value!)
  }
  queue.on('queue:updated', (update) => update.upserts.forEach((job) => remember(transfers, job)))
  operations.on('operation:updated', (jobs) => jobs.forEach((job) => remember(ops, job)))

  const get = (ids: string[]): JobSnapshot[] => {
    // 지금 목록에 있는 것이 기억한 것보다 새롭다
    const allTransfers = new Map([...transfers, ...queue.getAll().map((j) => [j.id, j] as const)])
    const allOps = new Map([...ops, ...operations.getAll().map((j) => [j.id, j] as const)])
    return ids.map((id) => {
      const job = allTransfers.get(id) ?? allOps.get(id)
      if (job) return 'fileName' in job ? transferView(job) : operationView(job)
      const members = [...allTransfers.values()].filter((j) => j.batchId === id)
      if (members.length > 0) return batchView(id, members)
      return { id, kind: 'transfer', status: 'unknown', done: true, name: '' }
    })
  }

  return {
    wait: (ids, timeoutMs) =>
      new Promise((resolve) => {
        const finish = (): void => {
          clearTimeout(timer)
          queue.off('queue:updated', check)
          operations.off('operation:updated', check)
          resolve(get(ids))
        }
        const check = (): void => {
          if (get(ids).every((job) => job.done)) finish()
        }
        const timer = setTimeout(finish, timeoutMs)
        queue.on('queue:updated', check)
        operations.on('operation:updated', check)
        check()
      })
  }
}
