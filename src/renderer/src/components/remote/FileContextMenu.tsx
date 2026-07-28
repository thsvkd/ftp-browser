import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useSelectionStore } from '@renderer/stores/useSelectionStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { isSafeRemoteName, INVALID_REMOTE_NAME_MESSAGE } from '@shared/entryName'
import type { FtpFileEntry } from '@shared/types/ftp'
import type { DeleteTarget } from '@shared/types/operation'
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
  const clearSelection = useSelectionStore((s) => s.clearSelection)
  const [editing, setEditing] = useState<'rename' | 'newFolder' | null>(null)
  const [newName, setNewName] = useState('')

  const handleClose = useCallback(() => {
    setEditing(null)
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
    const confirmBeforeDelete = useSettingsStore.getState().confirmBeforeDelete
    const msg = isMulti
      ? `Delete ${selectedEntries.length} items?`
      : `Delete "${selectedEntries[0].name}"?`
    if (confirmBeforeDelete && !window.confirm(msg)) return
    const deleteTargets: DeleteTarget[] = selectedEntries.map((e) => ({
      path: buildRemotePath(e.name),
      isDirectory: e.type === 'directory'
    }))
    const result = await window.api.invoke<IpcResult<void>>('ftp:deleteBatch', deleteTargets)
    if (!result.success) {
      toast.error('Failed to delete', { description: result.error })
    }
    clearSelection()
    refresh()
    handleClose()
  }

  const handleRename = (): void => {
    if (!entry) return
    setNewName(entry.name)
    setEditing('rename')
  }

  const startNewFolder = (): void => {
    setNewName('')
    setEditing('newFolder')
  }

  const handleRenameSubmit = async (): Promise<void> => {
    const name = newName.trim()
    if (!entry || !name || name === entry.name) {
      handleClose()
      return
    }
    if (!isSafeRemoteName(name)) {
      toast.error('Invalid name', { description: INVALID_REMOTE_NAME_MESSAGE })
      handleClose()
      return
    }
    try {
      // 이 IPC는 실패 시 던지지 않고 { success: false }를 반환한다. 반환값을 안 보면
      // 550(권한 거부)·553(이름 거부) 같은 가장 흔한 실패가 조용히 통과한다.
      const result = await window.api.invoke<IpcResult<void>>(
        'ftp:rename',
        buildRemotePath(entry.name),
        buildRemotePath(name)
      )
      if (!result.success) {
        toast.error('Failed to rename', { description: result.error })
      }
    } catch (err) {
      toast.error('Failed to rename', {
        description: err instanceof Error ? err.message : String(err)
      })
    } finally {
      refresh()
      handleClose()
    }
  }

  const handleNewFolderSubmit = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) {
      handleClose()
      return
    }
    if (!isSafeRemoteName(name)) {
      toast.error('Invalid name', { description: INVALID_REMOTE_NAME_MESSAGE })
      handleClose()
      return
    }
    try {
      const result = await window.api.invoke<IpcResult<void>>('ftp:mkdir', buildRemotePath(name))
      if (!result.success) {
        toast.error('Failed to create folder', { description: result.error })
      }
    } catch (err) {
      toast.error('Failed to create folder', {
        description: err instanceof Error ? err.message : String(err)
      })
    } finally {
      refresh()
      handleClose()
    }
  }

  const submitEdit = (): void => {
    void (editing === 'rename' ? handleRenameSubmit() : handleNewFolderSubmit())
  }

  return (
    <div
      className="fixed z-50 min-w-[160px] rounded-md border border-gray-200 bg-white py-1 shadow-lg"
      style={{ left: position.x, top: position.y }}
      onClick={(e) => e.stopPropagation()}
      // 메뉴는 그리드 컨테이너의 DOM 자식이라 position:fixed여도 이벤트는 그대로 버블링된다.
      // 막지 않으면 메뉴 버튼을 누르는 순간 마퀴 선택 핸들러가 선택을 통째로 비운다.
      onMouseDown={(e) => e.stopPropagation()}
    >
      {editing ? (
        <div className="px-3 py-2">
          <input
            type="text"
            value={newName}
            aria-label={editing === 'rename' ? 'New name' : 'New folder name'}
            placeholder={editing === 'newFolder' ? 'New folder name' : undefined}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitEdit()
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
            onClick={startNewFolder}
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
