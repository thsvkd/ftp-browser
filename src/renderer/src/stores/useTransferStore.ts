import { create } from 'zustand'
import type {
  TransferDirection,
  TransferEnqueueItem,
  TransferJob,
  TransferUpdate
} from '@shared/types/transfer'
import type { IpcResult } from '@shared/types/ipc'

interface TransferStore {
  jobs: TransferJob[]
  setJobs: (jobs: TransferJob[]) => void
  /** 메인이 보낸 변경분을 목록에 반영한다. 순서는 유지하고, 처음 보는 작업은 뒤에 붙인다. */
  applyUpdate: (update: TransferUpdate) => void
  enqueue: (
    direction: TransferDirection,
    localPath: string,
    remotePath: string,
    fileName: string,
    totalBytes: number
  ) => Promise<void>
  enqueueBatch: (
    direction: TransferDirection,
    items: TransferEnqueueItem[],
    forceBatch?: boolean,
    remoteDirs?: string[]
  ) => Promise<void>
  cancel: (id: string) => Promise<void>
  clearCompleted: () => Promise<void>
}

export const useTransferStore = create<TransferStore>((set, get) => ({
  jobs: [],

  setJobs: (jobs) => set({ jobs }),

  applyUpdate: ({ upserts, removedIds }) => {
    if (upserts.length === 0 && removedIds.length === 0) return

    const jobs = [...get().jobs]
    const indexById = new Map(jobs.map((job, index) => [job.id, index]))
    for (const job of upserts) {
      const index = indexById.get(job.id)
      if (index === undefined) {
        indexById.set(job.id, jobs.length)
        jobs.push(job)
      } else {
        jobs[index] = job
      }
    }
    if (removedIds.length === 0) {
      set({ jobs })
      return
    }
    const removed = new Set(removedIds)
    set({ jobs: jobs.filter((job) => !removed.has(job.id)) })
  },

  enqueue: async (direction, localPath, remotePath, fileName, totalBytes) => {
    const result = (await window.api.invoke('transfer:enqueue', {
      direction,
      localPath,
      remotePath,
      fileName,
      totalBytes
    })) as IpcResult<string>
    if (!result.success) {
      throw new Error(result.error)
    }
  },

  enqueueBatch: async (direction, items, forceBatch = false, remoteDirs) => {
    if (items.length === 0) return
    const result = (await window.api.invoke('transfer:enqueueBatch', {
      direction,
      items,
      forceBatch,
      remoteDirs
    })) as IpcResult<string[]>
    if (!result.success) {
      throw new Error(result.error)
    }
  },

  cancel: async (id) => {
    await window.api.invoke('transfer:cancel', id)
  },

  clearCompleted: async () => {
    await window.api.invoke('transfer:clearCompleted')
  }
}))
