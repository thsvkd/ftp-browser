import { useState, useRef, useCallback, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useSelectionStore } from '@renderer/stores/useSelectionStore'
import { ThumbnailImage } from '@renderer/components/thumbnail/ThumbnailImage'
import { ImagePreviewModal } from '@renderer/components/thumbnail/ImagePreviewModal'
import { FileContextMenu } from './FileContextMenu'
import { FilePropertiesDialog } from './FilePropertiesDialog'
import type { FtpFileEntry } from '@shared/types/ftp'

const CELL_SIZE = 170
const ITEM_SIZE = 150

function getFileIcon(entry: FtpFileEntry): string {
  if (entry.type === 'directory') return '\u{1F4C1}'
  if (entry.type === 'symbolic-link') return '\u{1F517}'
  return '\u{1F4C4}'
}

export function FileGridView(): React.JSX.Element {
  const entries = useFtpStore((s) => s.entries)
  const currentPath = useFtpStore((s) => s.currentPath)
  const navigateTo = useFtpStore((s) => s.navigateTo)
  const navigateUp = useFtpStore((s) => s.navigateUp)

  const selectedNames = useSelectionStore((s) => s.selectedNames)
  const selectSingle = useSelectionStore((s) => s.selectSingle)
  const toggleSelect = useSelectionStore((s) => s.toggleSelect)
  const selectRange = useSelectionStore((s) => s.selectRange)

  const [previewEntry, setPreviewEntry] = useState<FtpFileEntry | null>(null)
  const [contextEntry, setContextEntry] = useState<FtpFileEntry | null>(null)
  const [contextPos, setContextPos] = useState<{ x: number; y: number } | null>(null)
  const [propertiesEntry, setPropertiesEntry] = useState<FtpFileEntry | null>(null)

  const parentRef = useRef<HTMLDivElement>(null)

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

  const hasParentRow = currentPath !== '/'
  const items: Array<FtpFileEntry | 'parent'> = hasParentRow ? ['parent', ...sorted] : sorted

  const getColumnCount = useCallback((): number => {
    if (!parentRef.current) return 4
    return Math.max(1, Math.floor(parentRef.current.clientWidth / CELL_SIZE))
  }, [])

  const columnCount = parentRef.current ? getColumnCount() : 4
  const rowCount = Math.ceil(items.length / columnCount)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => CELL_SIZE,
    overscan: 2
  })

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
    } else if (entry.isImage) {
      setPreviewEntry(entry)
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
    <div
      ref={parentRef}
      className="flex-1 overflow-auto"
      onContextMenu={(e) => handleContextMenu(e, null)}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative'
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const startIdx = virtualRow.index * columnCount
          const rowItems = items.slice(startIdx, startIdx + columnCount)

          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
              className="flex gap-1 px-2"
            >
              {rowItems.map((item, colIdx) => {
                if (item === 'parent') {
                  return (
                    <div
                      key="parent"
                      className="flex cursor-pointer flex-col items-center overflow-hidden rounded p-2 hover:bg-blue-50"
                      style={{ width: CELL_SIZE, height: CELL_SIZE }}
                      onDoubleClick={navigateUp}
                    >
                      <div className="flex min-h-0 flex-1 items-center justify-center text-3xl">
                        {'\u{1F4C1}'}
                      </div>
                      <span className="mt-1 max-w-full flex-shrink-0 truncate text-xs text-gray-500">
                        ..
                      </span>
                    </div>
                  )
                }

                const entry = item
                const isSelected = selectedNames.has(entry.name)

                return (
                  <div
                    key={`${virtualRow.index}-${colIdx}`}
                    className={`flex cursor-pointer flex-col items-center overflow-hidden rounded p-2 ${
                      isSelected ? 'bg-blue-100' : 'hover:bg-blue-50'
                    }`}
                    style={{ width: CELL_SIZE, height: CELL_SIZE }}
                    draggable={entry.type === 'file'}
                    onClick={(e) => handleClick(e, entry)}
                    onDoubleClick={() => handleDoubleClick(entry)}
                    onDragStart={(e) => handleDragStart(e, entry)}
                    onContextMenu={(e) => {
                      e.stopPropagation()
                      handleContextMenu(e, entry)
                    }}
                  >
                    <div className="flex min-h-0 flex-1 items-center justify-center">
                      {entry.isImage ? (
                        <ThumbnailImage
                          entry={entry}
                          size={ITEM_SIZE}
                          onClick={() => setPreviewEntry(entry)}
                        />
                      ) : (
                        <div className="flex items-center justify-center text-3xl">
                          {getFileIcon(entry)}
                        </div>
                      )}
                    </div>
                    <span
                      className="mt-1 max-w-full flex-shrink-0 truncate text-xs text-gray-700"
                      title={entry.name}
                    >
                      {entry.name}
                    </span>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {sorted.length === 0 && !hasParentRow && (
        <div className="flex items-center justify-center py-8 text-sm text-gray-400">
          Empty directory
        </div>
      )}

      <FileContextMenu
        entry={contextEntry}
        position={contextPos}
        onClose={() => setContextPos(null)}
        onShowProperties={setPropertiesEntry}
      />
      {propertiesEntry && (
        <FilePropertiesDialog entry={propertiesEntry} onClose={() => setPropertiesEntry(null)} />
      )}

      {previewEntry && (
        <ImagePreviewModal entry={previewEntry} onClose={() => setPreviewEntry(null)} />
      )}
    </div>
  )
}
