import { useState, useEffect, useCallback } from 'react'
import { X, Database, Trash2 } from 'lucide-react'
import {
  useSettingsStore,
  GALLERY_THUMB_MIN,
  GALLERY_THUMB_MAX
} from '@renderer/stores/useSettingsStore'
import { formatBytes } from '@renderer/lib/utils'
import type { IpcResult } from '@shared/types/ipc'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

interface CacheStats {
  totalBytes: number
  totalCount: number
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps): React.JSX.Element | null {
  const galleryThumbSize = useSettingsStore((s) => s.galleryThumbSize)
  const setGalleryThumbSize = useSettingsStore((s) => s.setGalleryThumbSize)
  const showHidden = useSettingsStore((s) => s.showHidden)
  const setShowHidden = useSettingsStore((s) => s.setShowHidden)
  const confirmBeforeDelete = useSettingsStore((s) => s.confirmBeforeDelete)
  const setConfirmBeforeDelete = useSettingsStore((s) => s.setConfirmBeforeDelete)

  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null)
  const [clearing, setClearing] = useState(false)

  const fetchCacheStats = useCallback(async () => {
    const result = await window.api.invoke<IpcResult<CacheStats>>('cache:getStats')
    if (result.success) {
      setCacheStats(result.data)
    }
  }, [])

  useEffect(() => {
    if (open) fetchCacheStats()
  }, [open, fetchCacheStats])

  if (!open) return null

  const handleClearCache = async (): Promise<void> => {
    setClearing(true)
    try {
      await window.api.invoke('cache:clear')
      await fetchCacheStats()
    } finally {
      setClearing(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[480px] rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close settings"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-6">
          {/* Gallery */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
              Gallery
            </h3>
            <div className="flex items-center justify-between">
              <label htmlFor="thumb-size" className="text-sm text-gray-700">
                Thumbnail size
              </label>
              <span className="text-sm tabular-nums text-gray-500">{galleryThumbSize}px</span>
            </div>
            <input
              id="thumb-size"
              type="range"
              min={GALLERY_THUMB_MIN}
              max={GALLERY_THUMB_MAX}
              value={galleryThumbSize}
              onChange={(e) => setGalleryThumbSize(Number(e.target.value))}
              className="mt-2 w-full accent-blue-600"
            />
            <p className="mt-1 text-xs text-gray-400">
              Tip: hold Ctrl and scroll inside a gallery to zoom.
            </p>
          </section>

          {/* Browsing */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
              Browsing
            </h3>
            <label className="flex cursor-pointer items-center justify-between py-1">
              <span className="text-sm text-gray-700">Show hidden files (dotfiles)</span>
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
                className="h-4 w-4 rounded accent-blue-600"
              />
            </label>
            <label className="flex cursor-pointer items-center justify-between py-1">
              <span className="text-sm text-gray-700">Confirm before deleting</span>
              <input
                type="checkbox"
                checked={confirmBeforeDelete}
                onChange={(e) => setConfirmBeforeDelete(e.target.checked)}
                className="h-4 w-4 rounded accent-blue-600"
              />
            </label>
          </section>

          {/* Cache */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
              Cache
            </h3>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-gray-700">
                <Database size={14} className="text-gray-400" />
                <span>
                  {cacheStats
                    ? `${cacheStats.totalCount} items (${formatBytes(cacheStats.totalBytes)})`
                    : 'Loading...'}
                </span>
              </div>
              <button
                onClick={handleClearCache}
                disabled={clearing || !cacheStats || cacheStats.totalCount === 0}
                className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 size={14} />
                {clearing ? 'Clearing...' : 'Clear cache'}
              </button>
            </div>
          </section>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
