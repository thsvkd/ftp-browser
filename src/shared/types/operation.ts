export type OperationKind = 'copy' | 'move' | 'delete'
export type OperationStatus = 'active' | 'completed' | 'failed' | 'cancelled'
export type OperationUnit = 'files' | 'bytes'

export interface OperationJob {
  id: string
  kind: OperationKind
  /** How many top-level items the user acted on; the renderer builds the localized summary from it. */
  itemCount: number
  /** Name of the single item when {@link itemCount} is 1 (e.g. "Deleting photo.jpg"). */
  itemName?: string
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
