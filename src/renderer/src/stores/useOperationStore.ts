import { create } from 'zustand'
import type { OperationJob, OperationProgress } from '@shared/types/operation'

interface OperationStore {
  jobs: OperationJob[]
  setJobs: (jobs: OperationJob[]) => void
  updateProgress: (progress: OperationProgress) => void
  cancel: (id: string) => Promise<void>
  clearFinished: () => Promise<void>
}

export const useOperationStore = create<OperationStore>((set, get) => ({
  jobs: [],

  setJobs: (jobs) => set({ jobs }),

  updateProgress: (progress) => {
    const jobs = get().jobs.map((j) =>
      j.id === progress.id
        ? { ...j, completed: progress.completed, currentItem: progress.currentItem }
        : j
    )
    set({ jobs })
  },

  cancel: async (id) => {
    await window.api.invoke('operation:cancel', id)
  },

  clearFinished: async () => {
    await window.api.invoke('operation:clearFinished')
  }
}))
