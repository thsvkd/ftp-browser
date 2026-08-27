import { create } from 'zustand'
import type {
  TransferDirection,
  TransferEnqueueItem,
  TransferJob,
  TransferProgress
} from '@shared/types/transfer'
import type { IpcResult } from '@shared/types/ipc'

interface TransferStore {
  jobs: TransferJob[]
  setJobs: (jobs: TransferJob[]) => void
  updateProgress: (progress: TransferProgress) => void
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
    forceBatch?: boolean
  ) => Promise<void>
  cancel: (id: string) => Promise<void>
  clearCompleted: () => Promise<void>
}

export const useTransferStore = create<TransferStore>((set, get) => ({
  jobs: [],

  setJobs: (jobs) => set({ jobs }),

  updateProgress: (progress) => {
    const jobs = get().jobs.map((j) =>
      j.id === progress.id ? { ...j, transferredBytes: progress.transferredBytes } : j
    )
    set({ jobs })
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

  enqueueBatch: async (direction, items, forceBatch = false) => {
    if (items.length === 0) return
    const result = (await window.api.invoke('transfer:enqueueBatch', {
      direction,
      items,
      forceBatch
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
