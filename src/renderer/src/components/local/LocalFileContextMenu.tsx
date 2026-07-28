import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useLocalSelectionStore } from '@renderer/stores/useLocalSelectionStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { joinLocalPath } from '@renderer/lib/localPath'
import { joinRemotePath } from '@renderer/lib/remoteDrop'
import { isSafeLocalName, INVALID_LOCAL_NAME_MESSAGE } from '@shared/entryName'
import type { LocalFileEntry } from '@shared/types/local'
import type { DeleteTarget } from '@shared/types/operation'
import type { IpcResult } from '@shared/types/ipc'

interface Position {
  x: number
  y: number
}

export interface LocalFileContextMenuProps {
  entry: LocalFileEntry | null
  position: Position | null
  onClose: () => void
  onShowProperties?: (entry: LocalFileEntry) => void
}

/** Which name the inline input is collecting, if any. */
type Editing = 'rename' | 'newFolder' | null

export function LocalFileContextMenu({
  entry,
  position,
  onClose,
  onShowProperties
}: LocalFileContextMenuProps): React.JSX.Element | null {
  const currentPath = useLocalFsStore((s) => s.currentPath)
  const entries = useLocalFsStore((s) => s.entries)
  const refresh = useLocalFsStore((s) => s.refresh)
  const enqueue = useTransferStore((s) => s.enqueue)
  const selectedNames = useLocalSelectionStore((s) => s.selectedNames)
  const clearSelection = useLocalSelectionStore((s) => s.clearSelection)
  const connectionStatus = useFtpStore((s) => s.connectionStatus)
  const [editing, setEditing] = useState<Editing>(null)
  const [draftName, setDraftName] = useState('')

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

  // 선택 병합 규칙은 원격 FileContextMenu와 동일해야 한다(핸드오프 주의점 4).
  const selectedEntries =
    entry && selectedNames.has(entry.name) && selectedNames.size > 1
      ? entries.filter((e) => selectedNames.has(e.name))
      : entry
        ? [entry]
        : []

  const isMulti = selectedEntries.length > 1
  const files = selectedEntries.filter((e) => e.type === 'file')
  // 업로드는 연결된 서버의 현재 경로를 대상으로 한다. 끊긴 상태에서는 보낼 곳이 없다.
  const canUpload = files.length > 0 && connectionStatus === 'connected'

  const handleUpload = async (): Promise<void> => {
    if (files.length === 0) return
    const remoteDir = useFtpStore.getState().currentPath
    try {
      for (const file of files) {
        await enqueue(
          'upload',
          file.path,
          joinRemotePath(remoteDir, file.name),
          file.name,
          file.size
        )
      }
    } catch (err) {
      toast.error('Failed to enqueue upload', {
        description: err instanceof Error ? err.message : String(err)
      })
    } finally {
      handleClose()
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (selectedEntries.length === 0) return
    const confirmBeforeDelete = useSettingsStore.getState().confirmBeforeDelete
    const msg = isMulti
      ? `Delete ${selectedEntries.length} items?`
      : `Delete "${selectedEntries[0].name}"?`
    if (confirmBeforeDelete && !window.confirm(msg)) {
      handleClose()
      return
    }
    const deleteTargets: DeleteTarget[] = selectedEntries.map((e) => ({
      path: e.path,
      isDirectory: e.type === 'directory'
    }))
    // invoke가 reject하면(preload 화이트리스트 거부 등) 아래 정리가 통째로 건너뛰어져
    // 메뉴가 열린 채 멈춘 화면이 남는다. LocalExplorer의 Delete 키 경로와 같은 구조로 막는다.
    try {
      const result = await window.api.invoke<IpcResult<void>>('local:deleteBatch', deleteTargets)
      if (!result.success) {
        toast.error('Failed to delete', { description: result.error })
      }
    } catch (err) {
      toast.error('Failed to delete', {
        description: err instanceof Error ? err.message : String(err)
      })
    } finally {
      clearSelection()
      refresh()
      handleClose()
    }
  }

  const startRename = (): void => {
    if (!entry) return
    setDraftName(entry.name)
    setEditing('rename')
  }

  const startNewFolder = (): void => {
    setDraftName('')
    setEditing('newFolder')
  }

  const submitRename = async (): Promise<void> => {
    const name = draftName.trim()
    if (!entry || !name || name === entry.name) {
      handleClose()
      return
    }
    if (!isSafeLocalName(name)) {
      toast.error('Invalid name', { description: INVALID_LOCAL_NAME_MESSAGE })
      handleClose()
      return
    }
    try {
      // 이름 충돌은 rename이 거부하는 정상 경로다. 조용히 삼키면 사용자는 이름이
      // 왜 그대로인지 알 수 없으므로 반드시 표면화한다.
      const result = await window.api.invoke<IpcResult<void>>(
        'local:rename',
        entry.path,
        joinLocalPath(currentPath, name)
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

  const submitNewFolder = async (): Promise<void> => {
    const name = draftName.trim()
    if (!name) {
      handleClose()
      return
    }
    if (!isSafeLocalName(name)) {
      toast.error('Invalid name', { description: INVALID_LOCAL_NAME_MESSAGE })
      handleClose()
      return
    }
    try {
      const result = await window.api.invoke<IpcResult<void>>(
        'local:mkdir',
        joinLocalPath(currentPath, name)
      )
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
    void (editing === 'rename' ? submitRename() : submitNewFolder())
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
            value={draftName}
            aria-label={editing === 'rename' ? 'New name' : 'New folder name'}
            placeholder={editing === 'newFolder' ? 'New folder name' : undefined}
            onChange={(e) => setDraftName(e.target.value)}
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
              {canUpload && (
                <button
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-blue-50"
                  onClick={handleUpload}
                >
                  {isMulti ? `Upload (${files.length})` : 'Upload'}
                </button>
              )}
              {!isMulti && (
                <button
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-blue-50"
                  onClick={startRename}
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
