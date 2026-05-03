import { create } from 'zustand'

interface ThumbnailData {
  dataUrl: string
  width: number
  height: number
}

interface LocalThumbnailStore {
  thumbnails: Record<string, ThumbnailData>
  errors: Record<string, string>

  setThumbnail: (cacheKey: string, data: ThumbnailData) => void
  setError: (cacheKey: string, error: string) => void
  clearError: (cacheKey: string) => void
  clearAll: () => void
}

export function buildLocalThumbnailKey(
  localPath: string,
  fileSize: number,
  modifiedAt: string
): string {
  return `${localPath}|${fileSize}|${modifiedAt}`
}

export const useLocalThumbnailStore = create<LocalThumbnailStore>((set) => ({
  thumbnails: {},
  errors: {},

  setThumbnail: (cacheKey, data) =>
    set((s) => ({ thumbnails: { ...s.thumbnails, [cacheKey]: data } })),

  setError: (cacheKey, error) => set((s) => ({ errors: { ...s.errors, [cacheKey]: error } })),

  clearError: (cacheKey) =>
    set((s) => {
      if (!(cacheKey in s.errors)) return s
      const rest = { ...s.errors }
      delete rest[cacheKey]
      return { errors: rest }
    }),

  clearAll: () => set({ thumbnails: {}, errors: {} })
}))
