import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import type {
  OperationJob,
  OperationKind,
  OperationProgress,
  OperationUnit
} from '@shared/types/operation'

/** Auto-remove completed jobs after this delay so the panel doesn't accumulate clutter. */
const COMPLETED_TTL_MS = 5000

/**
 * Tracks long-running file operations (copy/move/delete) and reports their
 * progress to the renderer. Mirrors the TransferQueue event contract but is
 * generic over file-count or byte-based progress.
 *
 * Emits:
 *  - `operation:updated` (full job list) on any state change
 *  - `operation:progress` (single job) on incremental progress
 */
export class OperationManager extends EventEmitter {
  private jobs: OperationJob[] = []
  private cancelled = new Set<string>()

  create(kind: OperationKind, label: string, unit: OperationUnit, total: number): OperationJob {
    const job: OperationJob = {
      id: randomUUID(),
      kind,
      label,
      unit,
      total,
      completed: 0,
      status: 'active'
    }
    this.jobs.push(job)
    this.emitUpdated()
    return job
  }

  progress(id: string, completed: number, currentItem?: string): void {
    const job = this.jobs.find((j) => j.id === id)
    if (!job || job.status !== 'active') return
    job.completed = completed
    job.currentItem = currentItem
    const payload: OperationProgress = { id, completed, total: job.total, currentItem }
    this.emit('operation:progress', payload)
  }

  complete(id: string): void {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return
    job.status = 'completed'
    job.completed = job.total
    job.currentItem = undefined
    this.emitUpdated()
    this.scheduleRemoval(id)
  }

  fail(id: string, error: string): void {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return
    job.status = 'failed'
    job.error = error
    job.currentItem = undefined
    this.emitUpdated()
  }

  /** Request cancellation; running loops should poll {@link isCancelled}. */
  requestCancel(id: string): void {
    const job = this.jobs.find((j) => j.id === id)
    if (!job || job.status !== 'active') return
    this.cancelled.add(id)
  }

  isCancelled(id: string): boolean {
    return this.cancelled.has(id)
  }

  /** Mark a job as cancelled once its loop has stopped. */
  markCancelled(id: string): void {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return
    job.status = 'cancelled'
    job.currentItem = undefined
    this.cancelled.delete(id)
    this.emitUpdated()
    this.scheduleRemoval(id)
  }

  clearFinished(): void {
    this.jobs = this.jobs.filter((j) => j.status === 'active')
    this.emitUpdated()
  }

  getAll(): OperationJob[] {
    return [...this.jobs]
  }

  private scheduleRemoval(id: string): void {
    setTimeout(() => {
      const job = this.jobs.find((j) => j.id === id)
      // Keep failed jobs around so the user can read the error.
      if (!job || job.status === 'failed') return
      this.jobs = this.jobs.filter((j) => j.id !== id)
      this.emitUpdated()
    }, COMPLETED_TTL_MS)
  }

  private emitUpdated(): void {
    this.emit('operation:updated', this.getAll())
  }
}
