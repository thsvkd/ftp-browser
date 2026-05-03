import { create } from 'zustand'
import type { RemoteFolderPreview, LocalFolderPreview } from '@shared/types/gallery'

type RemoteState =
  | { status: 'pending' }
  | { status: 'resolved'; preview: RemoteFolderPreview | null }
  | { status: 'error'; error: string }

type LocalState =
  | { status: 'pending' }
  | { status: 'resolved'; preview: LocalFolderPreview | null }
  | { status: 'error'; error: string }

interface GalleryStore {
  remoteFolderPreviews: Record<string, RemoteState>
  localFolderPreviews: Record<string, LocalState>

  setRemotePending: (key: string) => void
  setRemoteResolved: (key: string, preview: RemoteFolderPreview | null) => void
  setRemoteError: (key: string, error: string) => void

  setLocalPending: (key: string) => void
  setLocalResolved: (key: string, preview: LocalFolderPreview | null) => void
  setLocalError: (key: string, error: string) => void

  clearAll: () => void
  clearRemote: () => void
  clearLocal: () => void
}

export const useGalleryStore = create<GalleryStore>((set) => ({
  remoteFolderPreviews: {},
  localFolderPreviews: {},

  setRemotePending: (key) =>
    set((s) => ({
      remoteFolderPreviews: { ...s.remoteFolderPreviews, [key]: { status: 'pending' } }
    })),

  setRemoteResolved: (key, preview) =>
    set((s) => ({
      remoteFolderPreviews: {
        ...s.remoteFolderPreviews,
        [key]: { status: 'resolved', preview }
      }
    })),

  setRemoteError: (key, error) =>
    set((s) => ({
      remoteFolderPreviews: { ...s.remoteFolderPreviews, [key]: { status: 'error', error } }
    })),

  setLocalPending: (key) =>
    set((s) => ({
      localFolderPreviews: { ...s.localFolderPreviews, [key]: { status: 'pending' } }
    })),

  setLocalResolved: (key, preview) =>
    set((s) => ({
      localFolderPreviews: {
        ...s.localFolderPreviews,
        [key]: { status: 'resolved', preview }
      }
    })),

  setLocalError: (key, error) =>
    set((s) => ({
      localFolderPreviews: { ...s.localFolderPreviews, [key]: { status: 'error', error } }
    })),

  clearAll: () => set({ remoteFolderPreviews: {}, localFolderPreviews: {} }),
  clearRemote: () => set({ remoteFolderPreviews: {} }),
  clearLocal: () => set({ localFolderPreviews: {} })
}))
