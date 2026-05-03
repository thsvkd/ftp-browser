import { useState, useMemo } from 'react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useSelectionStore } from '@renderer/stores/useSelectionStore'
import { FileContextMenu } from './FileContextMenu'
import { FilePropertiesDialog } from './FilePropertiesDialog'
import { formatBytes, formatDate } from '@renderer/lib/utils'
import type { FtpFileEntry } from '@shared/types/ftp'

function getFileIcon(entry: FtpFileEntry): string {
  if (entry.type === 'directory') return '📁'
  if (entry.isImage) return '🖼️'
  if (entry.type === 'symbolic-link') return '🔗'
  return '📄'
}

export function FileListView(): React.JSX.Element {
  const entries = useFtpStore((s) => s.entries)
  const currentPath = useFtpStore((s) => s.currentPath)
  const navigateTo = useFtpStore((s) => s.navigateTo)
  const navigateUp = useFtpStore((s) => s.navigateUp)

  const selectedNames = useSelectionStore((s) => s.selectedNames)
  const selectSingle = useSelectionStore((s) => s.selectSingle)
  const toggleSelect = useSelectionStore((s) => s.toggleSelect)
  const selectRange = useSelectionStore((s) => s.selectRange)

  const [contextEntry, setContextEntry] = useState<FtpFileEntry | null>(null)
  const [contextPos, setContextPos] = useState<{ x: number; y: number } | null>(null)
  const [propertiesEntry, setPropertiesEntry] = useState<FtpFileEntry | null>(null)

  const sorted = useMemo(
    () =>
      [...entries].sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1
        if (a.type !== 'directory' && b.type === 'directory') return 1
        return a.name.localeCompare(b.name)
      }),
    [entries]
  )

  const sortedNames = useMemo(() => sorted.map((e) => e.name), [sorted])

  const handleClick = (e: React.MouseEvent, entry: FtpFileEntry): void => {
    if (e.shiftKey) {
      selectRange(entry.name, sortedNames)
    } else if (e.ctrlKey || e.metaKey) {
      toggleSelect(entry.name)
    } else {
      selectSingle(entry.name)
    }
  }

  const handleDoubleClick = (entry: FtpFileEntry): void => {
    if (entry.type === 'directory') {
      const newPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`
      navigateTo(newPath)
    }
  }

  const handleContextMenu = (e: React.MouseEvent, entry: FtpFileEntry | null): void => {
    e.preventDefault()
    if (entry && !selectedNames.has(entry.name)) {
      selectSingle(entry.name)
    }
    setContextEntry(entry)
    setContextPos({ x: e.clientX, y: e.clientY })
  }

  const handleDragStart = (e: React.DragEvent, entry: FtpFileEntry): void => {
    const sel = useSelectionStore.getState().selectedNames
    const allEntries = useFtpStore.getState().entries
    const path = useFtpStore.getState().currentPath

    let filesToDrag: Array<{ remotePath: string; fileName: string; size: number }>
    if (sel.has(entry.name)) {
      filesToDrag = allEntries
        .filter((en) => sel.has(en.name) && en.type === 'file')
        .map((en) => ({
          remotePath: path === '/' ? `/${en.name}` : `${path}/${en.name}`,
          fileName: en.name,
          size: en.size
        }))
    } else {
      if (entry.type !== 'file') return
      filesToDrag = [
        {
          remotePath: path === '/' ? `/${entry.name}` : `${path}/${entry.name}`,
          fileName: entry.name,
          size: entry.size
        }
      ]
    }
    if (filesToDrag.length === 0) {
      e.preventDefault()
      return
    }

    e.dataTransfer.setData('application/x-remote-files', JSON.stringify(filesToDrag))
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div className="flex-1 overflow-auto" onContextMenu={(e) => handleContextMenu(e, null)}>
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 bg-gray-100 text-xs text-gray-500">
          <tr>
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="w-24 px-3 py-2 text-right font-medium">Size</th>
            <th className="w-44 px-3 py-2 font-medium">Modified</th>
          </tr>
        </thead>
        <tbody>
          {currentPath !== '/' && (
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
              onContextMenu={(e) => {
                e.stopPropagation()
                handleContextMenu(e, entry)
              }}
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
      <FileContextMenu
        entry={contextEntry}
        position={contextPos}
        onClose={() => setContextPos(null)}
        onShowProperties={setPropertiesEntry}
      />
      {propertiesEntry && (
        <FilePropertiesDialog entry={propertiesEntry} onClose={() => setPropertiesEntry(null)} />
      )}
    </div>
  )
}
