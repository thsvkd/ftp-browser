import { create } from 'zustand'
import type { ConnKey } from '@shared/connKey'
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
  /** 그 서버의 폴더 미리보기 항목만 지운다(키 `server|folderPath`). 다른 서버의 것은 남는다 */
  clearRemote: (server: ConnKey) => void
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
  clearRemote: (server) =>
    set((s) => ({
      remoteFolderPreviews: Object.fromEntries(
        Object.entries(s.remoteFolderPreviews).filter(([key]) => !key.startsWith(`${server}|`))
      )
    }))
}))
