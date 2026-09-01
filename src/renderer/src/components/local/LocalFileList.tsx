import { useState, useMemo, useRef, useEffect } from 'react'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { useLocalSelectionStore } from '@renderer/stores/useLocalSelectionStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useContextMenuStore, CONTEXT_MENU_OWNERS } from '@renderer/stores/useContextMenuStore'
import { useScrollRestoration } from '@renderer/hooks/useScrollRestoration'
import { shouldDeferToNativeContextMenu } from '@renderer/lib/debugTools'
import { isRootPath } from '@renderer/lib/localPath'
import { currentPlatform, isToggleSelectModifier } from '@renderer/lib/platform'
import { LocalFileContextMenu } from './LocalFileContextMenu'
import { LocalFilePropertiesDialog } from './LocalFilePropertiesDialog'
import { formatBytes, formatDate, filterHidden } from '@renderer/lib/utils'
import type { LocalFileEntry } from '@shared/types/local'

// Module-scoped so positions survive the remount that navigation triggers.
const SCROLL_POSITIONS = new Map<string, number>()

const MENU_OWNER = CONTEXT_MENU_OWNERS.localList

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

  const [contextEntry, setContextEntry] = useState<LocalFileEntry | null>(null)
  const [contextPos, setContextPos] = useState<{ x: number; y: number } | null>(null)
  const [propertiesEntry, setPropertiesEntry] = useState<LocalFileEntry | null>(null)

  const menuOwnerId = useContextMenuStore((s) => s.ownerId)
  const claimMenu = useContextMenuStore((s) => s.open)
  const releaseMenu = useContextMenuStore((s) => s.close)

  const showHidden = useSettingsStore((s) => s.showHidden)
  const scrollRef = useRef<HTMLDivElement>(null)
  useScrollRestoration(scrollRef, currentPath, SCROLL_POSITIONS)

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

  // 소유권을 뺏기면 내 메뉴를 닫는다 (함정 A: 반드시 !== MENU_OWNER)
  useEffect(() => {
    // 소유권 이동은 다른 뷰가 만드는 외부 신호라 이 뷰의 렌더만으로는 알 수 없다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    <div
      ref={scrollRef}
      className="flex-1 overflow-auto"
      onContextMenu={(e) => handleContextMenu(e, null)}
    >
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
