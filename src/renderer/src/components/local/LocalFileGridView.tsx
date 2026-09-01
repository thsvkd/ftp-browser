import { useState, useRef, useCallback, useMemo, useEffect, useLayoutEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { useLocalSelectionStore } from '@renderer/stores/useLocalSelectionStore'
import { useContextMenuStore, CONTEXT_MENU_OWNERS } from '@renderer/stores/useContextMenuStore'
import {
  useSettingsStore,
  GALLERY_CELL_PADDING,
  GALLERY_THUMB_STEP
} from '@renderer/stores/useSettingsStore'
import { LocalThumbnailImage } from '@renderer/components/thumbnail/LocalThumbnailImage'
import { LocalFolderThumbnail } from '@renderer/components/thumbnail/LocalFolderThumbnail'
import { useMarqueeSelection, type MarqueeRect } from '@renderer/hooks/useMarqueeSelection'
import { useScrollRestoration } from '@renderer/hooks/useScrollRestoration'
import { shouldDeferToNativeContextMenu } from '@renderer/lib/debugTools'
import { itemIndicesInRect } from '@renderer/lib/gridGeometry'
import { isRootPath } from '@renderer/lib/localPath'
import { currentPlatform, isToggleSelectModifier, isZoomModifier } from '@renderer/lib/platform'
import { filterHidden } from '@renderer/lib/utils'
import { LocalFileContextMenu } from './LocalFileContextMenu'
import { LocalFilePropertiesDialog } from './LocalFilePropertiesDialog'
import type { LocalFileEntry } from '@shared/types/local'

const GRID_ITEM_SIZE = 150
// Spacing between cells. Roomy enough that drags reliably start a marquee
// selection on empty space instead of grabbing an item for drag-and-drop.
const GRID_GAP = 14
const GRID_PADDING_X = 8
// Module-scoped so positions survive the remount that navigation triggers.
const SCROLL_POSITIONS = new Map<string, number>()
const MENU_OWNER = CONTEXT_MENU_OWNERS.localGrid

function getFileIcon(entry: LocalFileEntry): string {
  if (entry.type === 'directory') return '\u{1F4C1}'
  return '\u{1F4C4}'
}

interface LocalFileGridViewProps {
  /** When true, show folders + image files only and use folder previews */
  gallery?: boolean
}

export function LocalFileGridView({ gallery = false }: LocalFileGridViewProps): React.JSX.Element {
  const entries = useLocalFsStore((s) => s.entries)
  const currentPath = useLocalFsStore((s) => s.currentPath)
  const navigateTo = useLocalFsStore((s) => s.navigateTo)
  const navigateUp = useLocalFsStore((s) => s.navigateUp)

  const selectedNames = useLocalSelectionStore((s) => s.selectedNames)
  const selectSingle = useLocalSelectionStore((s) => s.selectSingle)
  const toggleSelect = useLocalSelectionStore((s) => s.toggleSelect)
  const selectRange = useLocalSelectionStore((s) => s.selectRange)
  const selectAll = useLocalSelectionStore((s) => s.selectAll)

  const [contextEntry, setContextEntry] = useState<LocalFileEntry | null>(null)
  const [contextPos, setContextPos] = useState<{ x: number; y: number } | null>(null)
  const [propertiesEntry, setPropertiesEntry] = useState<LocalFileEntry | null>(null)

  const menuOwnerId = useContextMenuStore((s) => s.ownerId)
  const claimMenu = useContextMenuStore((s) => s.open)
  const releaseMenu = useContextMenuStore((s) => s.close)

  const showHidden = useSettingsStore((s) => s.showHidden)
  const galleryThumbSize = useSettingsStore((s) => s.galleryThumbSize)
  const adjustGalleryThumbSize = useSettingsStore((s) => s.adjustGalleryThumbSize)

  // Gallery mode is zoomable; grid mode keeps a fixed thumbnail size.
  const itemSize = gallery ? galleryThumbSize : GRID_ITEM_SIZE
  const cellSize = itemSize + GALLERY_CELL_PADDING

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

  const hasParentRow = !isRootPath(currentPath)
  const items: Array<LocalFileEntry | 'parent'> = hasParentRow ? ['parent', ...sorted] : sorted

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
    getSelection: () => useLocalSelectionStore.getState().selectedNames
  })

  useScrollRestoration(parentRef, currentPath, SCROLL_POSITIONS)

  // Re-measure rows when the zoom level (cell size) or column layout changes.
  // useLayoutEffect so the reflow happens before paint (no flicker on zoom).
  useLayoutEffect(() => {
    virtualizer.measure()
  }, [cellSize, columnCount, virtualizer])

  // Ctrl/Cmd+wheel zooms gallery thumbnails. Native non-passive listener so we
  // can preventDefault (otherwise Electron zooms the whole page).
  useEffect(() => {
    const el = parentRef.current
    if (!el || !gallery) return
    const onWheel = (e: WheelEvent): void => {
      if (!isZoomModifier(e, currentPlatform())) return
      e.preventDefault()
      adjustGalleryThumbSize(e.deltaY < 0 ? GALLERY_THUMB_STEP : -GALLERY_THUMB_STEP)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [gallery, adjustGalleryThumbSize])

  // 소유권을 뺏기면 내 메뉴를 닫는다(함정 A: 반드시 !== MENU_OWNER)
  useEffect(() => {
    if (menuOwnerId !== MENU_OWNER) setContextPos(null)
  }, [menuOwnerId])

  const handleClick = (e: React.MouseEvent, entry: LocalFileEntry): void => {
    if (e.shiftKey) {
      selectRange(entry.name, sortedNames)
    } else if (isToggleSelectModifier(e, currentPlatform())) {
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

  const handleContextMenu = (e: React.MouseEvent, entry: LocalFileEntry | null): void => {
    if (shouldDeferToNativeContextMenu(e, window.api?.debugToolsEnabled ?? false)) return
    e.preventDefault()
    if (entry && !selectedNames.has(entry.name)) {
      selectSingle(entry.name)
    }
    claimMenu(MENU_OWNER)
    setContextEntry(entry)
    setContextPos({ x: e.clientX, y: e.clientY })
  }

  const handleDragStart = (e: React.DragEvent, entry: LocalFileEntry): void => {
    const sel = useLocalSelectionStore.getState().selectedNames
    const allEntries = useLocalFsStore.getState().entries

    let filesToDrag: Array<{ localPath: string; fileName: string; size: number }>
    if (sel.has(entry.name)) {
      filesToDrag = allEntries
        .filter((en) => sel.has(en.name) && en.type === 'file')
        .map((en) => ({ localPath: en.path, fileName: en.name, size: en.size }))
    } else {
      if (entry.type !== 'file') return
      filesToDrag = [{ localPath: entry.path, fileName: entry.name, size: entry.size }]
    }
    if (filesToDrag.length === 0) {
      e.preventDefault()
      return
    }

    e.dataTransfer.setData('application/x-local-files', JSON.stringify(filesToDrag))
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
                        <LocalThumbnailImage
                          localPath={entry.path}
                          fileSize={entry.size}
                          modifiedAt={entry.modifiedAt}
                          alt={entry.name}
                        />
                      ) : entry.type === 'directory' && gallery ? (
                        <LocalFolderThumbnail folderPath={entry.path} size={itemSize} />
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

      <LocalFileContextMenu
        entry={contextEntry}
        position={contextPos}
        onClose={() => {
          setContextPos(null)
          releaseMenu(MENU_OWNER)
        }}
        onShowProperties={setPropertiesEntry}
      />
      {propertiesEntry && (
        <LocalFilePropertiesDialog
          entry={propertiesEntry}
          onClose={() => setPropertiesEntry(null)}
        />
      )}
    </div>
  )
}
