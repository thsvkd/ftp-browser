import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { THUMBNAIL_SIZE } from '@shared/constants'

export type ViewMode = 'list' | 'grid' | 'gallery'

/** Gallery thumbnail size bounds (px), used by Ctrl+wheel zoom and the settings slider. */
export const GALLERY_THUMB_MIN = 96
/** Never display larger than we generate, so the image stays crisp at max zoom. */
export const GALLERY_THUMB_MAX = THUMBNAIL_SIZE
export const GALLERY_THUMB_DEFAULT = 150
export const GALLERY_THUMB_STEP = 24

/** Extra height a gallery cell adds around the square thumbnail for label + padding. */
export const GALLERY_CELL_PADDING = 40

function clampThumbSize(size: number): number {
  if (Number.isNaN(size)) return GALLERY_THUMB_DEFAULT
  return Math.min(GALLERY_THUMB_MAX, Math.max(GALLERY_THUMB_MIN, Math.round(size)))
}

interface SettingsStore {
  remoteViewMode: ViewMode
  localViewMode: ViewMode
  galleryThumbSize: number
  showHidden: boolean
  confirmBeforeDelete: boolean

  setRemoteViewMode: (mode: ViewMode) => void
  setLocalViewMode: (mode: ViewMode) => void
  setGalleryThumbSize: (size: number) => void
  adjustGalleryThumbSize: (delta: number) => void
  setShowHidden: (show: boolean) => void
  setConfirmBeforeDelete: (confirm: boolean) => void
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      remoteViewMode: 'list',
      localViewMode: 'list',
      galleryThumbSize: GALLERY_THUMB_DEFAULT,
      showHidden: false,
      confirmBeforeDelete: true,

      setRemoteViewMode: (mode) => set({ remoteViewMode: mode }),
      setLocalViewMode: (mode) => set({ localViewMode: mode }),
      setGalleryThumbSize: (size) => set({ galleryThumbSize: clampThumbSize(size) }),
      adjustGalleryThumbSize: (delta) =>
        set((s) => ({ galleryThumbSize: clampThumbSize(s.galleryThumbSize + delta) })),
      setShowHidden: (show) => set({ showHidden: show }),
      setConfirmBeforeDelete: (confirm) => set({ confirmBeforeDelete: confirm })
    }),
    {
      name: 'ftp-browser-settings',
      version: 1
    }
  )
)
