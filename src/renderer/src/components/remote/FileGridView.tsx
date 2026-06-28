import { useState, useRef, useCallback, useMemo, useEffect, useLayoutEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useSelectionStore } from '@renderer/stores/useSelectionStore'
import {
  useSettingsStore,
  GALLERY_CELL_PADDING,
  GALLERY_THUMB_STEP
} from '@renderer/stores/useSettingsStore'
import { ThumbnailImage } from '@renderer/components/thumbnail/ThumbnailImage'
import { RemoteFolderThumbnail } from '@renderer/components/thumbnail/RemoteFolderThumbnail'
import { ImagePreviewModal } from '@renderer/components/thumbnail/ImagePreviewModal'
import { useMarqueeSelection, type MarqueeRect } from '@renderer/hooks/useMarqueeSelection'
import { useScrollRestoration } from '@renderer/hooks/useScrollRestoration'
import { itemIndicesInRect } from '@renderer/lib/gridGeometry'
import { filterHidden } from '@renderer/lib/utils'
import { FileContextMenu } from './FileContextMenu'
import { FilePropertiesDialog } from './FilePropertiesDialog'
import type { FtpFileEntry } from '@shared/types/ftp'

const GRID_ITEM_SIZE = 150
// Spacing between cells. Roomy enough that drags reliably start a marquee
// selection on empty space instead of grabbing an item for drag-and-drop.
const GRID_GAP = 14
const GRID_PADDING_X = 8
// Module-scoped so positions survive the remount that navigation triggers.
const SCROLL_POSITIONS = new Map<string, number>()

function getFileIcon(entry: FtpFileEntry): string {
  if (entry.type === 'directory') return '\u{1F4C1}'
  if (entry.type === 'symbolic-link') return '\u{1F517}'
  return '\u{1F4C4}'
}

interface FileGridViewProps {
  /** When true, show folders + image files only and use folder previews */
  gallery?: boolean
}

export function FileGridView({ gallery = false }: FileGridViewProps): React.JSX.Element {
  const entries = useFtpStore((s) => s.entries)
  const currentPath = useFtpStore((s) => s.currentPath)
  const host = useFtpStore((s) => s.host)
  const port = useFtpStore((s) => s.port)
  const navigateTo = useFtpStore((s) => s.navigateTo)
  const navigateUp = useFtpStore((s) => s.navigateUp)

  const selectedNames = useSelectionStore((s) => s.selectedNames)
  const selectSingle = useSelectionStore((s) => s.selectSingle)
  const toggleSelect = useSelectionStore((s) => s.toggleSelect)
  const selectRange = useSelectionStore((s) => s.selectRange)
  const selectAll = useSelectionStore((s) => s.selectAll)

  const showHidden = useSettingsStore((s) => s.showHidden)
  const galleryThumbSize = useSettingsStore((s) => s.galleryThumbSize)
  const adjustGalleryThumbSize = useSettingsStore((s) => s.adjustGalleryThumbSize)

  // Gallery mode is zoomable; grid mode keeps a fixed thumbnail size.
  const itemSize = gallery ? galleryThumbSize : GRID_ITEM_SIZE
  const cellSize = itemSize + GALLERY_CELL_PADDING

  const [previewEntry, setPreviewEntry] = useState<FtpFileEntry | null>(null)
  const [contextEntry, setContextEntry] = useState<FtpFileEntry | null>(null)
  const [contextPos, setContextPos] = useState<{ x: number; y: number } | null>(null)
  const [propertiesEntry, setPropertiesEntry] = useState<FtpFileEntry | null>(null)

  const parentRef = useRef<HTMLDivElement>(null)

  const sorted = useMemo(() => {
    const base = gallery ? entries.filter((e) => e.type === 'directory' || e.isImage) : entries
    return filterHidden(base, showHidden).sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1
      if (a.type !== 'directory' && b.type === 'directory') return 1
      return a.name.localeCompare(b.name)
    })
  }, [entries, gallery, showHidden])

  const sortedNames = useMemo(() => sorted.map((e) => e.name), [sorted])

  const hasParentRow = currentPath !== '/'
  const items: Array<FtpFileEntry | 'parent'> = hasParentRow ? ['parent', ...sorted] : sorted

  const getColumnCount = useCallback((): number => {
    if (!parentRef.current) return 4
    const available = parentRef.current.clientWidth - 2 * GRID_PADDING_X
    return Math.max(1, Math.floor((available + GRID_GAP) / (cellSize + GRID_GAP)))
  }, [cellSize])

  const columnCount = parentRef.current ? getColumnCount() : 4
  const rowCount = Math.ceil(items.length / columnCount)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => cellSize + GRID_GAP,
    overscan: 2
  })

  // Marquee (rubber-band) selection over empty space in the grid.
  const namesInRect = useCallback(
    (rect: MarqueeRect): string[] =>
      itemIndicesInRect(
        rect,
        sorted.length,
        columnCount,
        cellSize,
        GRID_GAP,
        GRID_PADDING_X,
        hasParentRow ? 1 : 0
      ).map((i) => sorted[i].name),
    [sorted, columnCount, cellSize, hasParentRow]
  )

  const { marquee, onMouseDown: onMarqueeMouseDown } = useMarqueeSelection({
    scrollRef: parentRef,
    namesInRect,
    setSelection: selectAll,
    getSelection: () => useSelectionStore.getState().selectedNames
  })

  useScrollRestoration(parentRef, `${host}:${port}:${currentPath}`, SCROLL_POSITIONS)

  // Re-measure rows when the zoom level (cell size) or column layout changes.
  // useLayoutEffect so the reflow happens before paint (no flicker on zoom).
  useLayoutEffect(() => {
    virtualizer.measure()
  }, [cellSize, columnCount, virtualizer])

  // Ctrl+wheel zooms gallery thumbnails. Native non-passive listener so we can
  // preventDefault (otherwise Electron zooms the whole page).
  useEffect(() => {
    const el = parentRef.current
    if (!el || !gallery) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      adjustGalleryThumbSize(e.deltaY < 0 ? GALLERY_THUMB_STEP : -GALLERY_THUMB_STEP)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [gallery, adjustGalleryThumbSize])

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
      className="flex-1 select-none overflow-auto"
      onContextMenu={(e) => handleContextMenu(e, null)}
      onMouseDown={onMarqueeMouseDown}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative'
        }}
      >
        {marquee && (
          <div
            className="pointer-events-none absolute z-10 rounded-sm border border-blue-400 bg-blue-400/15"
            style={{
              left: marquee.left,
              top: marquee.top,
              width: marquee.width,
              height: marquee.height
            }}
          />
        )}
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
                transform: `translateY(${virtualRow.start}px)`,
                gap: GRID_GAP,
                paddingLeft: GRID_PADDING_X,
                paddingRight: GRID_PADDING_X
              }}
              className="flex items-start"
            >
              {rowItems.map((item, colIdx) => {
                if (item === 'parent') {
                  return (
                    <div
                      key="parent"
                      data-grid-cell
                      className="flex cursor-pointer flex-col items-center overflow-hidden rounded p-2 hover:bg-blue-50"
                      style={{ width: cellSize, height: cellSize }}
                      onDoubleClick={navigateUp}
                    >
                      <div
                        className="flex min-h-0 w-full flex-1 items-center justify-center leading-none"
                        style={{ fontSize: Math.round(itemSize * 0.55) }}
                      >
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
                const folderPath =
                  entry.type === 'directory'
                    ? currentPath === '/'
                      ? `/${entry.name}`
                      : `${currentPath}/${entry.name}`
                    : ''

                return (
                  <div
                    key={`${virtualRow.index}-${colIdx}`}
                    data-grid-cell
                    className={`flex cursor-pointer flex-col items-center overflow-hidden rounded p-2 ${
                      isSelected ? 'bg-blue-100' : 'hover:bg-blue-50'
                    }`}
                    style={{ width: cellSize, height: cellSize }}
                    draggable={entry.type === 'file'}
                    onClick={(e) => handleClick(e, entry)}
                    onDoubleClick={() => handleDoubleClick(entry)}
                    onDragStart={(e) => handleDragStart(e, entry)}
                    onContextMenu={(e) => {
                      e.stopPropagation()
                      handleContextMenu(e, entry)
                    }}
                  >
                    <div className="flex min-h-0 w-full flex-1 items-center justify-center">
                      {entry.isImage ? (
                        <ThumbnailImage entry={entry} />
                      ) : entry.type === 'directory' && gallery ? (
                        <RemoteFolderThumbnail folderPath={folderPath} size={itemSize} />
                      ) : (
                        <div
                          className="flex items-center justify-center leading-none"
                          style={{ fontSize: Math.round(itemSize * 0.5) }}
                        >
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
