import { useState, useEffect, useCallback } from 'react'
import { Database, Trash2 } from 'lucide-react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { formatBytes, filterHidden } from '@renderer/lib/utils'
import type { IpcResult } from '@shared/types/ipc'

interface CacheStats {
  totalBytes: number
  totalCount: number
}

export function StatusBar(): React.JSX.Element {
  const connectionStatus = useFtpStore((s) => s.connectionStatus)
  const entries = useFtpStore((s) => s.entries)
  const currentPath = useFtpStore((s) => s.currentPath)
  const showHidden = useSettingsStore((s) => s.showHidden)

  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null)
  const [clearing, setClearing] = useState(false)

  // Count only what the file views actually show (respect the hidden-files setting).
  const visibleEntries = filterHidden(entries, showHidden)
  const dirCount = visibleEntries.filter((e) => e.type === 'directory').length
  const fileCount = visibleEntries.filter((e) => e.type === 'file').length

  const fetchCacheStats = useCallback(async () => {
    const result = await window.api.invoke<IpcResult<CacheStats>>('cache:getStats')
    if (result.success) {
      setCacheStats(result.data)
    }
  }, [])

  useEffect(() => {
    fetchCacheStats()
    const interval = setInterval(fetchCacheStats, 30_000)
    return () => clearInterval(interval)
  }, [fetchCacheStats])

  const handleClearCache = async (): Promise<void> => {
    setClearing(true)
    try {
      await window.api.invoke('cache:clear')
      await fetchCacheStats()
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-3 py-1 text-xs text-gray-500">
      <div>
        {connectionStatus === 'connected' && (
          <span>
            {currentPath} — {dirCount} directories, {fileCount} files
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {cacheStats && (
          <div className="flex items-center gap-1.5">
            <Database size={12} className="text-gray-400" />
            <span>
              Cache: {cacheStats.totalCount} items ({formatBytes(cacheStats.totalBytes)})
            </span>
            {cacheStats.totalCount > 0 && (
              <button
                onClick={handleClearCache}
                disabled={clearing}
                className="ml-0.5 rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-red-500 disabled:opacity-50"
                title="Clear thumbnail cache"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )}
        <span className="capitalize">{connectionStatus}</span>
      </div>
    </div>
  )
}
