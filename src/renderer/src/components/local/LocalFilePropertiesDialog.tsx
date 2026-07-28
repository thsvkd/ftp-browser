import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { InfoRow } from '@renderer/components/common/InfoRow'
import { formatBytes, formatDate, getFileExtension } from '@renderer/lib/utils'
import type { LocalFileEntry } from '@shared/types/local'

export interface LocalFilePropertiesDialogProps {
  entry: LocalFileEntry
  onClose: () => void
}

// 원격 FilePropertiesDialog와 같은 라벨 규칙이지만, 이미지 판정은 확장자 목록을
// 다시 들고 있지 않고 list()가 이미 채워 둔 entry.isImage를 그대로 쓴다.
function getFileTypeLabel(entry: LocalFileEntry): string {
  if (entry.type === 'directory') return 'Directory'
  const ext = getFileExtension(entry.name)
  if (entry.isImage) return `Image (${ext.substring(1).toUpperCase()})`
  if (ext) return `${ext.substring(1).toUpperCase()} File`
  return 'File'
}

export function LocalFilePropertiesDialog({
  entry,
  onClose
}: LocalFilePropertiesDialogProps): React.JSX.Element {
  const currentPath = useLocalFsStore((s) => s.currentPath)

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
          <InfoRow label="Full Path" value={entry.path} />
          {entry.type === 'file' && (
            <InfoRow
              label="Size"
              value={`${formatBytes(entry.size)} (${entry.size.toLocaleString()} bytes)`}
            />
          )}
          <InfoRow label="Modified" value={formatDate(entry.modifiedAt)} />
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
