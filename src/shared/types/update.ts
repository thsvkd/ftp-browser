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
  /** Download updates in the background and install them when the app quits. */
  autoUpdate: boolean
  availableVersion?: string
  progressPercent?: number
  message?: string
}
