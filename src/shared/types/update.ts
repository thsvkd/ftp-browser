export type UpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'up-to-date'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion?: string
  progressPercent?: number
  message?: string
}
