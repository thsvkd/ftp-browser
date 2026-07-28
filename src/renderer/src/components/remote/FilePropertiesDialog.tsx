import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { InfoRow } from '@renderer/components/common/InfoRow'
import { formatBytes, formatDate, getFileExtension } from '@renderer/lib/utils'
import type { FtpFileEntry } from '@shared/types/ftp'

interface FilePropertiesDialogProps {
  entry: FtpFileEntry
  onClose: () => void
}

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.webp',
  '.tiff',
  '.tif',
  '.svg',
  '.ico'
])

function getFileTypeLabel(entry: FtpFileEntry): string {
  if (entry.type === 'directory') return 'Directory'
  if (entry.type === 'symbolic-link') return 'Symbolic Link'
  const ext = getFileExtension(entry.name)
  if (IMAGE_EXTENSIONS.has(ext)) return `Image (${ext.substring(1).toUpperCase()})`
  if (ext) return `${ext.substring(1).toUpperCase()} File`
  return 'File'
}

export function FilePropertiesDialog({
  entry,
  onClose
}: FilePropertiesDialogProps): React.JSX.Element {
  const currentPath = useFtpStore((s) => s.currentPath)
  const remotePath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
      // 오버레이도 그리드 컨테이너의 DOM 자식이라, 막지 않으면 마퀴 선택 핸들러가 함께 돈다.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="w-80 rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h3 className="text-sm font-semibold text-gray-800">Properties</h3>
          <button
            onClick={onClose}
            className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X size={16} />
          </button>
        </div>

        <div className="divide-y divide-gray-100 px-4 py-2 text-sm">
          <InfoRow label="Name" value={entry.name} />
          <InfoRow label="Type" value={getFileTypeLabel(entry)} />
          <InfoRow label="Location" value={currentPath} />
          <InfoRow label="Full Path" value={remotePath} />
          {entry.type === 'file' && (
            <InfoRow
              label="Size"
              value={`${formatBytes(entry.size)} (${entry.size.toLocaleString()} bytes)`}
            />
          )}
          <InfoRow label="Modified" value={formatDate(entry.modifiedAt)} />
          <InfoRow label="Permissions" value={entry.permissions} />
        </div>

        <div className="flex justify-end border-t border-gray-200 px-4 py-3">
          <button
            onClick={onClose}
            className="rounded bg-gray-100 px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-200"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
