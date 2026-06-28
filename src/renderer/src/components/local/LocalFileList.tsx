import { useMemo } from 'react'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { useLocalSelectionStore } from '@renderer/stores/useLocalSelectionStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { isRootPath } from '@renderer/lib/localPath'
import { formatBytes, formatDate, filterHidden } from '@renderer/lib/utils'
import type { LocalFileEntry } from '@shared/types/local'

function getFileIcon(entry: LocalFileEntry): string {
  if (entry.type === 'directory') return '📁'
  if (entry.isImage) return '🖼️'
  return '📄'
}

export function LocalFileList(): React.JSX.Element {
  const entries = useLocalFsStore((s) => s.entries)
  const currentPath = useLocalFsStore((s) => s.currentPath)
  const navigateTo = useLocalFsStore((s) => s.navigateTo)
  const navigateUp = useLocalFsStore((s) => s.navigateUp)

  const selectedNames = useLocalSelectionStore((s) => s.selectedNames)
  const selectSingle = useLocalSelectionStore((s) => s.selectSingle)
  const toggleSelect = useLocalSelectionStore((s) => s.toggleSelect)
  const selectRange = useLocalSelectionStore((s) => s.selectRange)

  const showHidden = useSettingsStore((s) => s.showHidden)

  const sorted = useMemo(
    () =>
      filterHidden(entries, showHidden).sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1
        if (a.type !== 'directory' && b.type === 'directory') return 1
        return a.name.localeCompare(b.name)
      }),
    [entries, showHidden]
  )

  const sortedNames = useMemo(() => sorted.map((e) => e.name), [sorted])

  const handleClick = (e: React.MouseEvent, entry: LocalFileEntry): void => {
    if (e.shiftKey) {
      selectRange(entry.name, sortedNames)
    } else if (e.ctrlKey || e.metaKey) {
      toggleSelect(entry.name)
    } else {
      selectSingle(entry.name)
    }
  }

  const handleDoubleClick = (entry: LocalFileEntry): void => {
    if (entry.type === 'directory') {
      navigateTo(entry.path)
    }
  }

  const handleDragStart = (e: React.DragEvent, entry: LocalFileEntry): void => {
    const sel = useLocalSelectionStore.getState().selectedNames
    const allEntries = useLocalFsStore.getState().entries

    let filesToDrag: Array<{ localPath: string; fileName: string; size: number }>
    if (sel.has(entry.name)) {
      filesToDrag = allEntries
        .filter((en) => sel.has(en.name) && en.type === 'file')
        .map((en) => ({
          localPath: en.path,
          fileName: en.name,
          size: en.size
        }))
    } else {
      if (entry.type !== 'file') return
      filesToDrag = [
        {
          localPath: entry.path,
          fileName: entry.name,
          size: entry.size
        }
      ]
    }

    if (filesToDrag.length === 0) {
      e.preventDefault()
      return
    }

    e.dataTransfer.setData('application/x-local-files', JSON.stringify(filesToDrag))
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 bg-gray-100 text-xs text-gray-500">
          <tr>
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="w-24 px-3 py-2 text-right font-medium">Size</th>
            <th className="w-44 px-3 py-2 font-medium">Modified</th>
          </tr>
        </thead>
        <tbody>
          {!isRootPath(currentPath) && (
            <tr className="cursor-pointer hover:bg-blue-50" onDoubleClick={navigateUp}>
              <td className="px-3 py-1.5">
                <span className="mr-2">📁</span>
                <span className="text-gray-500">..</span>
              </td>
              <td />
              <td />
            </tr>
          )}
          {sorted.map((entry) => (
            <tr
              key={entry.name}
              className={`cursor-pointer ${
                selectedNames.has(entry.name) ? 'bg-blue-100' : 'hover:bg-blue-50'
              }`}
              draggable={entry.type === 'file'}
              onClick={(e) => handleClick(e, entry)}
              onDoubleClick={() => handleDoubleClick(entry)}
              onDragStart={(e) => handleDragStart(e, entry)}
            >
              <td className="px-3 py-1.5">
                <span className="mr-2">{getFileIcon(entry)}</span>
                <span className={entry.type === 'directory' ? 'font-medium' : ''}>
                  {entry.name}
                </span>
              </td>
              <td className="px-3 py-1.5 text-right text-gray-500">
                {entry.type === 'file' ? formatBytes(entry.size) : '--'}
              </td>
              <td className="w-44 max-w-[11rem] px-3 py-1.5 text-gray-500">
                <span className="block truncate" title={formatDate(entry.modifiedAt)}>
                  {formatDate(entry.modifiedAt)}
                </span>
              </td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={3} className="px-3 py-8 text-center text-gray-400">
                Empty directory
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
