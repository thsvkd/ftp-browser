import { create } from 'zustand'

interface ThumbnailData {
  dataUrl: string
  width: number
  height: number
}

interface ThumbnailStore {
  thumbnails: Record<string, ThumbnailData>
  errors: Record<string, string>

  setThumbnail: (cacheKey: string, data: ThumbnailData) => void
  setError: (cacheKey: string, error: string) => void
  clearError: (cacheKey: string) => void
  getThumbnail: (cacheKey: string) => ThumbnailData | undefined
  clearAll: () => void
}

export const useThumbnailStore = create<ThumbnailStore>((set, get) => ({
  thumbnails: {},
  errors: {},

  setThumbnail: (cacheKey, data) => {
    set((state) => ({
      thumbnails: { ...state.thumbnails, [cacheKey]: data }
    }))
  },

  setError: (cacheKey, error) => {
    set((state) => ({
      errors: { ...state.errors, [cacheKey]: error }
    }))
  },

  clearError: (cacheKey) => {
    set((state) => {
      const { [cacheKey]: _, ...rest } = state.errors
      return { errors: rest }
    })
  },

  getThumbnail: (cacheKey) => {
    return get().thumbnails[cacheKey]
  },

  clearAll: () => {
    set({ thumbnails: {}, errors: {} })
  }
}))
