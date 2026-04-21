import { useState, useEffect, useCallback } from 'react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useSelectionStore } from '@renderer/stores/useSelectionStore'
import type { FtpFileEntry } from '@shared/types/ftp'
import type { IpcResult } from '@shared/types/ipc'

interface Position {
  x: number
  y: number
}

interface FileContextMenuProps {
  entry: FtpFileEntry | null
  position: Position | null
  onClose: () => void
  onShowProperties?: (entry: FtpFileEntry) => void
}

export function FileContextMenu({
  entry,
  position,
  onClose,
  onShowProperties
}: FileContextMenuProps): React.JSX.Element | null {
  const currentPath = useFtpStore((s) => s.currentPath)
  const entries = useFtpStore((s) => s.entries)
  const refresh = useFtpStore((s) => s.refresh)
  const enqueue = useTransferStore((s) => s.enqueue)
  const selectedNames = useSelectionStore((s) => s.selectedNames)
  const [renaming, setRenaming] = useState(false)
  const [newName, setNewName] = useState('')

  const handleClose = useCallback(() => {
    setRenaming(false)
    onClose()
  }, [onClose])

  useEffect(() => {
    const handler = (): void => handleClose()
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [handleClose])

  if (!position) return null

  // 다중 선택 시 선택된 파일 목록, 단일 선택 시 우클릭된 항목
  const selectedEntries =
    entry && selectedNames.has(entry.name) && selectedNames.size > 1
      ? entries.filter((e) => selectedNames.has(e.name))
      : entry
        ? [entry]
        : []

  const isMulti = selectedEntries.length > 1
  const hasFiles = selectedEntries.some((e) => e.type === 'file')

  const buildRemotePath = (name: string): string =>
    currentPath === '/' ? `/${name}` : `${currentPath}/${name}`

  const handleDownload = async (): Promise<void> => {
    const files = selectedEntries.filter((e) => e.type === 'file')
    if (files.length === 0) return
    const result = await window.api.invoke<IpcResult<string | null>>('local:selectSaveDirectory')
    if (result.success && result.data) {
      for (const file of files) {
        const destPath = `${result.data}/${file.name}`
        const remotePath = buildRemotePath(file.name)
        enqueue('download', destPath, remotePath, file.name, file.size)
      }
    }
    handleClose()
  }

  const handleDelete = async (): Promise<void> => {
    if (selectedEntries.length === 0) return
    const msg = isMulti
      ? `Delete ${selectedEntries.length} items?`
      : `Delete "${selectedEntries[0].name}"?`
    const confirmed = window.confirm(msg)
    if (!confirmed) return
    for (const e of selectedEntries) {
      const remotePath = buildRemotePath(e.name)
      await window.api.invoke('ftp:delete', remotePath, e.type === 'directory')
    }
    refresh()
    handleClose()
  }

  const handleRename = (): void => {
    if (!entry) return
    setNewName(entry.name)
    setRenaming(true)
  }

  const handleRenameSubmit = async (): Promise<void> => {
    if (!entry || !newName || newName === entry.name) {
      handleClose()
      return
    }
    const oldPath = buildRemotePath(entry.name)
    const newPath = buildRemotePath(newName)
    await window.api.invoke('ftp:rename', oldPath, newPath)
    refresh()
    handleClose()
  }

  const handleNewFolder = async (): Promise<void> => {
    const name = window.prompt('New folder name:')
    if (!name) return
    const newPath = buildRemotePath(name)
    await window.api.invoke('ftp:mkdir', newPath)
    refresh()
    handleClose()
  }

  return (
    <div
      className="fixed z-50 min-w-[160px] rounded-md border border-gray-200 bg-white py-1 shadow-lg"
      style={{ left: position.x, top: position.y }}
      onClick={(e) => e.stopPropagation()}
    >
      {renaming ? (
        <div className="px-3 py-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameSubmit()
              if (e.key === 'Escape') handleClose()
            }}
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
            autoFocus
          />
        </div>
      ) : (
        <>
          {selectedEntries.length > 0 && (
            <>
              {hasFiles && (
                <button
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-blue-50"
                  onClick={handleDownload}
                >
                  {isMulti
                    ? `Download (${selectedEntries.filter((e) => e.type === 'file').length})`
                    : 'Download'}
                </button>
              )}
              {!isMulti && (
                <button
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-blue-50"
                  onClick={handleRename}
                >
                  Rename
                </button>
              )}
              <button
                className="w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50"
                onClick={handleDelete}
              >
                {isMulti ? `Delete (${selectedEntries.length})` : 'Delete'}
              </button>
              <div className="my-1 border-t border-gray-100" />
            </>
          )}
          <button
            className="w-full px-3 py-1.5 text-left text-sm hover:bg-blue-50"
            onClick={handleNewFolder}
          >
            New Folder
          </button>
          {!isMulti && entry && onShowProperties && (
            <>
              <div className="my-1 border-t border-gray-100" />
              <button
                className="w-full px-3 py-1.5 text-left text-sm hover:bg-blue-50"
                onClick={() => {
                  onShowProperties(entry)
                  handleClose()
                }}
              >
                Properties
              </button>
            </>
          )}
        </>
      )}
    </div>
  )
}
