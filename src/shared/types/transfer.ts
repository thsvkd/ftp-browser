export type TransferDirection = 'upload' | 'download'
export type TransferStatus = 'pending' | 'active' | 'completed' | 'failed' | 'cancelled'

export interface TransferEnqueueItem {
  localPath: string
  remotePath: string
  fileName: string
  totalBytes: number
}

export interface TransferJob {
  id: string
  /** Shared by files enqueued as one multi-file/folder transfer. */
  batchId?: string
  direction: TransferDirection
  localPath: string
  remotePath: string
  fileName: string
  totalBytes: number
  transferredBytes: number
  status: TransferStatus
  error?: string
  retryCount?: number
  startedAt?: string
  completedAt?: string
}

/**
 * 메인 프로세스가 일정 주기(`FLUSH_MS`)로 모아서 보내는 변경분.
 * `upserts`는 마지막 전송 이후 바뀐 작업의 스냅샷(진행률 포함), `removedIds`는 목록에서 빠진 작업이다.
 */
export interface TransferUpdate {
  upserts: TransferJob[]
  removedIds: string[]
}
