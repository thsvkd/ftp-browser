export type OperationKind = 'copy' | 'move' | 'delete'
export type OperationStatus = 'active' | 'completed' | 'failed' | 'cancelled'
export type OperationUnit = 'files' | 'bytes'

export interface OperationJob {
  id: string
  kind: OperationKind
  /** Human-readable summary, e.g. "Copying 3 files" or "Deleting photo.jpg". */
  label: string
  /** Whether {@link total}/{@link completed} are measured in files or bytes. */
  unit: OperationUnit
  total: number
  completed: number
  status: OperationStatus
  error?: string
  /** Name of the item currently being processed (for the detail line). */
  currentItem?: string
}

export interface OperationProgress {
  id: string
  completed: number
  total: number
  currentItem?: string
}

/** A single delete target sent to the batch-delete handlers. */
export interface DeleteTarget {
  path: string
  isDirectory: boolean
}
