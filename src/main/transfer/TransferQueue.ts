import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { FtpFileOperations } from '../ftp/FtpFileOperations'
import { classifyError, isRetryableError } from '../utils/errorClassifier'
import type { TransferJob, TransferDirection, TransferProgress } from '@shared/types/transfer'

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000

export class TransferQueue extends EventEmitter {
  private queue: TransferJob[] = []
  private activeJob: TransferJob | null = null

  constructor(private fileOps: FtpFileOperations) {
    super()
  }

  enqueue(
    direction: TransferDirection,
    localPath: string,
    remotePath: string,
    fileName: string,
    totalBytes: number
  ): string {
    const id = randomUUID()
    const job: TransferJob = {
      id,
      direction,
      localPath,
      remotePath,
      fileName,
      totalBytes,
      transferredBytes: 0,
      status: 'pending'
    }
    this.queue.push(job)
    this.emit('queue:updated', this.getAll())
    this.processNext()
    return id
  }

  cancel(id: string): void {
    const job = this.queue.find((j) => j.id === id)
    if (job && job.status === 'pending') {
      job.status = 'cancelled'
      this.emit('queue:updated', this.getAll())
    }
  }

  clearCompleted(): void {
    this.queue = this.queue.filter(
      (j) => j.status !== 'completed' && j.status !== 'failed' && j.status !== 'cancelled'
    )
    this.emit('queue:updated', this.getAll())
  }

  getAll(): TransferJob[] {
    return [...this.queue]
  }

  private async processNext(): Promise<void> {
    if (this.activeJob) return

    const next = this.queue.find((j) => j.status === 'pending')
    if (!next) return

    this.activeJob = next
    next.status = 'active'
    next.startedAt = new Date().toISOString()
    this.emit('queue:updated', this.getAll())

    const onProgress = (info: { bytes: number; bytesOverall: number }): void => {
      next.transferredBytes = info.bytesOverall
      const progress: TransferProgress = {
        id: next.id,
        transferredBytes: info.bytesOverall,
        totalBytes: next.totalBytes,
        percent: next.totalBytes > 0 ? Math.round((info.bytesOverall / next.totalBytes) * 100) : 0
      }
      this.emit('transfer:progress', progress)
    }

    try {
      if (next.direction === 'download') {
        await this.fileOps.download(next.remotePath, next.localPath, onProgress)
      } else {
        await this.fileOps.upload(next.localPath, next.remotePath, onProgress)
      }
      next.status = 'completed'
      next.completedAt = new Date().toISOString()
    } catch (err) {
      const retryCount = next.retryCount ?? 0
      if (isRetryableError(err) && retryCount < MAX_RETRIES) {
        next.retryCount = retryCount + 1
        next.status = 'pending'
        next.transferredBytes = 0
        next.error = `Retry ${next.retryCount}/${MAX_RETRIES}: ${classifyError(err).message}`
        this.activeJob = null
        this.emit('queue:updated', this.getAll())
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
        this.processNext()
        return
      }
      next.status = 'failed'
      next.error = classifyError(err).message
    }

    this.activeJob = null
    this.emit('queue:updated', this.getAll())
    this.processNext()
  }
}
