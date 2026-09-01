import { useState, useEffect, useCallback } from 'react'
import { X, Database, Trash2 } from 'lucide-react'
import {
  useSettingsStore,
  GALLERY_THUMB_MIN,
  GALLERY_THUMB_MAX
} from '@renderer/stores/useSettingsStore'
import { formatBytes } from '@renderer/lib/utils'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useOperationStore } from '@renderer/stores/useOperationStore'
import type { IpcResult } from '@shared/types/ipc'
import type { UpdateState } from '@shared/types/update'

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
  const hasActiveTransfers = useTransferStore((s) =>
    s.jobs.some((job) => job.status === 'pending' || job.status === 'active')
  )
  const hasActiveOperations = useOperationStore((s) =>
    s.jobs.some((job) => job.status === 'active')
  )

  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null)
  const [clearing, setClearing] = useState(false)
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)

  const fetchCacheStats = useCallback(async () => {
    const result = await window.api.invoke<IpcResult<CacheStats>>('cache:getStats')
    if (result.success) {
      setCacheStats(result.data)
    }
  }, [])

  const fetchUpdateState = useCallback(async () => {
    const result = await window.api.invoke<IpcResult<UpdateState>>('update:getState')
    if (result.success) setUpdateState(result.data)
  }, [])

  useEffect(() => {
    if (!open) return
    void fetchCacheStats()
    void fetchUpdateState()
    return window.api.on('update:stateChanged', (...args: unknown[]) => {
      setUpdateState(args[0] as UpdateState)
    })
  }, [open, fetchCacheStats, fetchUpdateState])

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

  const runUpdateCommand = async (channel: 'update:check' | 'update:download'): Promise<void> => {
    const result = await window.api.invoke<IpcResult<UpdateState>>(channel)
    if (result.success) setUpdateState(result.data)
  }

  const installUpdate = (): void => {
    if (
      (hasActiveTransfers || hasActiveOperations) &&
      !window.confirm('A file operation is still running. Restart and interrupt it?')
    ) {
      return
    }
    void window.api.invoke('update:install')
  }

  const updateDescription = (): string => {
    if (!updateState) return 'Loading...'
    switch (updateState.status) {
      case 'unsupported':
        return updateState.message ?? 'Automatic updates are not available for this build.'
      case 'checking':
        return 'Checking for updates...'
      case 'available':
        return `Version ${updateState.availableVersion} is available.`
      case 'downloading':
        return `Downloading ${Math.round(updateState.progressPercent ?? 0)}%`
      case 'ready':
        return `Version ${updateState.availableVersion} is ready to install.`
      case 'up-to-date':
        return 'You are using the latest version.'
      case 'error':
        return updateState.message ?? 'Update check failed.'
      default:
        return 'Updates are checked when the app starts.'
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

          {/* Updates */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
              Updates
            </h3>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm text-gray-700">
                  {updateState ? `Version ${updateState.currentVersion}` : 'Version'}
                </div>
                <p className="mt-0.5 text-xs text-gray-400">{updateDescription()}</p>
              </div>
              {updateState?.status === 'available' ? (
                <button
                  onClick={() => void runUpdateCommand('update:download')}
                  className="shrink-0 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Download {updateState.availableVersion}
                </button>
              ) : updateState?.status === 'ready' ? (
                <button
                  onClick={installUpdate}
                  className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Restart and update
                </button>
              ) : updateState?.status !== 'unsupported' ? (
                <button
                  onClick={() => void runUpdateCommand('update:check')}
                  disabled={
                    !updateState ||
                    updateState.status === 'checking' ||
                    updateState.status === 'downloading'
                  }
                  className="shrink-0 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {updateState?.status === 'checking'
                    ? 'Checking...'
                    : updateState?.status === 'downloading'
                      ? `Downloading ${Math.round(updateState.progressPercent ?? 0)}%`
                      : 'Check for updates'}
                </button>
              ) : null}
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
