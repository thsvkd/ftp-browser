import { useEscapeKey } from '@renderer/hooks/useEscapeKey'
import { X } from 'lucide-react'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { InfoRow } from '@renderer/components/common/InfoRow'
import { formatBytes, formatDate, getFileExtension } from '@renderer/lib/utils'
import { useT } from '@renderer/i18n'
import type { LocalFileEntry } from '@shared/types/local'

export interface LocalFilePropertiesDialogProps {
  entry: LocalFileEntry
  onClose: () => void
}

// 원격 FilePropertiesDialog와 같은 라벨 규칙이지만, 이미지 판정은 확장자 목록을
// 다시 들고 있지 않고 list()가 이미 채워 둔 entry.isImage를 그대로 쓴다.
function getFileTypeLabel(entry: LocalFileEntry, t: ReturnType<typeof useT>): string {
  if (entry.type === 'directory') return t('fileType.folder')
  const ext = getFileExtension(entry.name)
  if (entry.isImage) return t('fileType.image', { ext: ext.substring(1).toUpperCase() })
  if (ext) return t('fileType.withExtension', { ext: ext.substring(1).toUpperCase() })
  return t('fileType.file')
}

export function LocalFilePropertiesDialog({
  entry,
  onClose
}: LocalFilePropertiesDialogProps): React.JSX.Element {
  const currentPath = useLocalFsStore((s) => s.currentPath)
  const t = useT()

  useEscapeKey(onClose)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
      // 오버레이도 그리드 컨테이너의 DOM 자식이라, 막지 않으면 마퀴 선택 핸들러가 함께 돈다.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-file-properties-title"
        className="w-80 rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h3 id="local-file-properties-title" className="text-sm font-semibold text-gray-800">
            {t('properties.title')}
          </h3>
          <button
            onClick={onClose}
            className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="divide-y divide-gray-100 px-4 py-2 text-sm">
          <InfoRow label={t('file.name')} value={entry.name} />
          <InfoRow label={t('file.type')} value={getFileTypeLabel(entry, t)} />
          <InfoRow label={t('properties.location')} value={currentPath} />
          <InfoRow label={t('properties.fullPath')} value={entry.path} />
          {entry.type === 'file' && (
            <InfoRow
              label={t('file.size')}
              value={t('properties.sizeValue', {
                size: formatBytes(entry.size),
                count: entry.size
              })}
            />
          )}
          <InfoRow label={t('file.modified')} value={formatDate(entry.modifiedAt)} />
        </div>

        <div className="flex justify-end border-t border-gray-200 px-4 py-3">
          <button
            onClick={onClose}
            className="rounded bg-gray-100 px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-200"
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
