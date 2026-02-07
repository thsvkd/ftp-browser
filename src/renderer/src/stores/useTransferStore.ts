import { create } from 'zustand'
import type { TransferJob, TransferProgress } from '@shared/types/transfer'

interface TransferStore {
  jobs: TransferJob[]
  setJobs: (jobs: TransferJob[]) => void
  updateProgress: (progress: TransferProgress) => void
  enqueue: (
    direction: 'upload' | 'download',
    localPath: string,
    remotePath: string,
    fileName: string,
    totalBytes: number
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
    await window.api.invoke('transfer:enqueue', {
      direction,
      localPath,
      remotePath,
      fileName,
      totalBytes
    })
  },

  cancel: async (id) => {
    await window.api.invoke('transfer:cancel', id)
  },

  clearCompleted: async () => {
    await window.api.invoke('transfer:clearCompleted')
  }
}))
