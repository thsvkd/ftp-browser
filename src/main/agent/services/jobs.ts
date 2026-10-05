import type { OperationJob } from '@shared/types/operation'
import type { TransferJob, TransferStatus, TransferUpdate } from '@shared/types/transfer'
import { MAX_PLAN_ITEMS, type AgentServices, type JobSnapshot } from '../types'
import type { AgentServiceDeps } from './index'

/**
 * 끝난 작업을 기억하는 최대 수. OperationManager는 끝난 작업을 5초 뒤 지우고 사용자는 전송 목록을 비울 수
 * 있어, 기억하지 않으면 늦게 wait한 에이전트가 결과 대신 'unknown'을 받는다. 오래된 것부터 잊는다.
 */
const REMEMBERED_JOBS = 2 * MAX_PLAN_ITEMS

/** queue.cancel()이 job.status를 바꾸므로 좁혀진 타입 대신 다시 읽는다(TransferQueue의 isCancelled와 같다). */
const statusOf = (job: TransferJob): TransferStatus => job.status

function transferSnapshot(job: TransferJob): JobSnapshot {
  return {
    id: job.id,
    kind: 'transfer',
    status: job.status,
    done: job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled',
    name: job.fileName,
    transferredBytes: job.transferredBytes,
    totalBytes: job.totalBytes,
    error: job.error
  }
}

function operationSnapshot(job: OperationJob): JobSnapshot {
  return {
    id: job.id,
    kind: 'operation',
    status: job.status,
    done: job.status !== 'active',
    name: job.itemName ?? `${job.kind} ${job.itemCount} items`,
    completed: job.completed,
    total: job.total,
    error: job.error
  }
}

export function createJobsService(
  deps: Pick<AgentServiceDeps, 'queue' | 'operations'>
): AgentServices['jobs'] {
  const { queue, operations } = deps
  const finished = new Map<string, JobSnapshot>()
  const remember = (snapshot: JobSnapshot): void => {
    if (!snapshot.done) return
    finished.delete(snapshot.id)
    finished.set(snapshot.id, snapshot)
    if (finished.size > REMEMBERED_JOBS) finished.delete(finished.keys().next().value!)
  }
  queue.on('queue:updated', (update: TransferUpdate) => {
    for (const job of update.upserts) remember(transferSnapshot(job))
  })
  operations.on('operation:updated', (jobs: OperationJob[]) => {
    for (const job of jobs) remember(operationSnapshot(job))
  })

  const get = (ids: string[]): JobSnapshot[] => {
    const transfers = new Map(queue.getAll().map((job) => [job.id, job]))
    const ops = new Map(operations.getAll().map((job) => [job.id, job]))
    return ids.map((id) => {
      const transfer = transfers.get(id)
      if (transfer) return transferSnapshot(transfer)
      const op = ops.get(id)
      if (op) return operationSnapshot(op)
      // kind는 정할 수 없다. 대부분은 비운 전송 id다.
      return finished.get(id) ?? { id, kind: 'transfer', status: 'unknown', done: true, name: '' }
    })
  }

  return {
    get,

    // 폴링하지 않는다: 큐(queue:updated, 최대 100 ms 주기)와 작업(operation:updated) 알림마다 다시 본다
    wait: (ids, timeoutMs) =>
      new Promise((resolve) => {
        const finish = (): void => {
          clearTimeout(timer)
          queue.off('queue:updated', check)
          operations.off('operation:updated', check)
          resolve(get(ids))
        }
        const check = (): void => {
          if (get(ids).every((s) => s.done)) finish()
        }
        const timer = setTimeout(finish, timeoutMs)
        queue.on('queue:updated', check)
        operations.on('operation:updated', check)
        check()
      }),

    cancel: (ids) => {
      const wanted = ids === 'all' ? null : new Set(ids)
      let count = 0
      for (const job of queue.getAll()) {
        if (
          (wanted && !wanted.has(job.id)) ||
          !(job.status === 'pending' || job.status === 'active')
        )
          continue
        // 메인 클라이언트로 도는 전송(보조 연결 불가 서버)은 큐가 취소하지 않는다
        queue.cancel(job.id)
        if (statusOf(job) === 'cancelled') count++
      }
      for (const op of operations.getAll()) {
        if (
          (wanted && !wanted.has(op.id)) ||
          op.status !== 'active' ||
          operations.isCancelled(op.id)
        )
          continue
        operations.requestCancel(op.id)
        count++
      }
      return count
    },

    clearFinished: () => {
      queue.clearCompleted()
      operations.clearFinished()
    }
  }
}
