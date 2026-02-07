import { useFtpStore } from '@renderer/stores/useFtpStore'

export function StatusBar(): React.JSX.Element {
  const connectionStatus = useFtpStore((s) => s.connectionStatus)
  const entries = useFtpStore((s) => s.entries)
  const currentPath = useFtpStore((s) => s.currentPath)

  const dirCount = entries.filter((e) => e.type === 'directory').length
  const fileCount = entries.filter((e) => e.type === 'file').length

  return (
    <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-3 py-1 text-xs text-gray-500">
      <div>
        {connectionStatus === 'connected' && (
          <span>
            {currentPath} — {dirCount} directories, {fileCount} files
          </span>
        )}
      </div>
      <div className="capitalize">{connectionStatus}</div>
    </div>
  )
}
