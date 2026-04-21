import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TransferQueue } from './TransferQueue'
import type { FtpFileOperations } from '../ftp/FtpFileOperations'

function createMockFileOps(): FtpFileOperations {
  return {
    upload: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    deleteDirectory: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined)
  } as unknown as FtpFileOperations
}

describe('TransferQueue', () => {
  let queue: TransferQueue
  let mockFileOps: FtpFileOperations

  beforeEach(() => {
    vi.clearAllMocks()
    mockFileOps = createMockFileOps()
    queue = new TransferQueue(mockFileOps)
  })

  describe('enqueue', () => {
    it('should add a job and return an id', () => {
      const id = queue.enqueue('download', '/local/file.jpg', '/remote/file.jpg', 'file.jpg', 1024)
      expect(id).toBeTruthy()
      expect(typeof id).toBe('string')
    })

    it('should emit queue:updated when a job is added', () => {
      const listener = vi.fn()
      queue.on('queue:updated', listener)

      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)

      expect(listener).toHaveBeenCalled()
      const jobs = listener.mock.calls[0][0]
      expect(jobs).toHaveLength(1)
      expect(jobs[0].fileName).toBe('a.jpg')
      expect(jobs[0].status).toBe('active') // immediately starts processing
    })

    it('should generate unique ids for each job', () => {
      const id1 = queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)
      const id2 = queue.enqueue('upload', '/local/b.jpg', '/remote/b.jpg', 'b.jpg', 200)
      expect(id1).not.toBe(id2)
    })
  })

  describe('getAll', () => {
    it('should return a copy of the queue', () => {
      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)
      const all = queue.getAll()
      expect(all).toHaveLength(1)
      // Should be a copy, not a reference
      all.pop()
      expect(queue.getAll()).toHaveLength(1)
    })

    it('should return empty array when no jobs', () => {
      expect(queue.getAll()).toEqual([])
    })
  })

  describe('cancel', () => {
    it('should cancel a pending job', async () => {
      // Make the first job hang so subsequent jobs stay pending
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {})
      )

      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100) // starts immediately
      const id2 = queue.enqueue('download', '/local/b.jpg', '/remote/b.jpg', 'b.jpg', 200)

      queue.cancel(id2)

      const jobs = queue.getAll()
      const job2 = jobs.find((j) => j.id === id2)
      expect(job2?.status).toBe('cancelled')
    })

    it('should not cancel an active job', async () => {
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {})
      )

      const id = queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)

      // Job is already active, cancel should have no effect
      queue.cancel(id)

      const jobs = queue.getAll()
      const job = jobs.find((j) => j.id === id)
      expect(job?.status).toBe('active')
    })
  })

  describe('clearCompleted', () => {
    it('should remove completed, failed, and cancelled jobs', async () => {
      // First job completes immediately
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)

      // Wait for processing
      await vi.waitFor(() => {
        const jobs = queue.getAll()
        expect(jobs.some((j) => j.status === 'completed')).toBe(true)
      })

      queue.clearCompleted()
      const remaining = queue.getAll()
      expect(remaining.filter((j) => j.status === 'completed')).toHaveLength(0)
    })
  })

  describe('processNext (sequential processing)', () => {
    it('should call download for download jobs', async () => {
      queue.enqueue('download', '/local/file.jpg', '/remote/file.jpg', 'file.jpg', 1024)

      await vi.waitFor(() => {
        expect(mockFileOps.download).toHaveBeenCalledWith(
          '/remote/file.jpg',
          '/local/file.jpg',
          expect.any(Function)
        )
      })
    })

    it('should call upload for upload jobs', async () => {
      queue.enqueue('upload', '/local/file.jpg', '/remote/file.jpg', 'file.jpg', 1024)

      await vi.waitFor(() => {
        expect(mockFileOps.upload).toHaveBeenCalledWith(
          '/local/file.jpg',
          '/remote/file.jpg',
          expect.any(Function)
        )
      })
    })

    it('should mark job as completed on success', async () => {
      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)

      await vi.waitFor(() => {
        const jobs = queue.getAll()
        expect(jobs[0].status).toBe('completed')
      })
    })

    it('should mark job as failed on error', async () => {
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Network error')
      )

      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)

      await vi.waitFor(() => {
        const jobs = queue.getAll()
        expect(jobs[0].status).toBe('failed')
        expect(jobs[0].error).toBe('Network error')
      })
    })

    it('should process jobs sequentially', async () => {
      let resolveFirst: () => void
      const firstPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve
      })
      ;(mockFileOps.download as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => firstPromise)
        .mockResolvedValueOnce(undefined)

      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 100)
      queue.enqueue('download', '/local/b.jpg', '/remote/b.jpg', 'b.jpg', 200)

      // Only first should be active
      const jobsWhileFirst = queue.getAll()
      expect(jobsWhileFirst[0].status).toBe('active')
      expect(jobsWhileFirst[1].status).toBe('pending')

      // Complete first
      resolveFirst!()

      await vi.waitFor(() => {
        const jobs = queue.getAll()
        expect(jobs[0].status).toBe('completed')
        expect(jobs[1].status === 'active' || jobs[1].status === 'completed').toBe(true)
      })
    })
  })

  describe('events', () => {
    it('should emit transfer:progress during transfer', async () => {
      let progressCallback: ((info: { bytes: number; bytesOverall: number }) => void) | null = null
      ;(mockFileOps.download as ReturnType<typeof vi.fn>).mockImplementation(
        (
          _remote: string,
          _local: string,
          onProgress?: (info: { bytes: number; bytesOverall: number }) => void
        ) => {
          progressCallback = onProgress ?? null
          if (progressCallback) {
            progressCallback({ bytes: 512, bytesOverall: 512 })
          }
          return Promise.resolve()
        }
      )

      const progressListener = vi.fn()
      queue.on('transfer:progress', progressListener)

      queue.enqueue('download', '/local/a.jpg', '/remote/a.jpg', 'a.jpg', 1024)

      await vi.waitFor(() => {
        expect(progressListener).toHaveBeenCalledWith(
          expect.objectContaining({
            transferredBytes: 512,
            totalBytes: 1024,
            percent: 50
          })
        )
      })
    })
  })
})
