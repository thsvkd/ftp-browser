export type TransferDirection = 'upload' | 'download'
export type TransferStatus = 'pending' | 'active' | 'completed' | 'failed' | 'cancelled'

export interface TransferJob {
  id: string
  direction: TransferDirection
  localPath: string
  remotePath: string
  fileName: string
  totalBytes: number
  transferredBytes: number
  status: TransferStatus
  error?: string
  startedAt?: string
  completedAt?: string
}

export interface TransferProgress {
  id: string
  transferredBytes: number
  totalBytes: number
  percent: number
}
