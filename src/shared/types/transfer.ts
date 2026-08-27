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

export interface TransferProgress {
  id: string
  transferredBytes: number
  totalBytes: number
  percent: number
}
