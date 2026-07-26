import { useEffect, useState, useRef } from 'react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useSelectionStore } from '@renderer/stores/useSelectionStore'
import { useGalleryStore } from '@renderer/stores/useGalleryStore'
import { RemoteBreadcrumb } from './RemoteBreadcrumb'
import { FileListView } from './FileListView'
import { FileGridView } from './FileGridView'
import { ViewModeToggle } from '@renderer/components/common/ViewModeToggle'
import { performRemoteDrop } from '@renderer/lib/remoteDrop'
import { toast } from 'sonner'
import type { FtpConnectionState } from '@shared/types/ftp'
import type { DeleteTarget } from '@shared/types/operation'
import type { IpcResult } from '@shared/types/ipc'

export function RemoteExplorer(): React.JSX.Element {
  const connectionStatus = useFtpStore((s) => s.connectionStatus)
  const currentPath = useFtpStore((s) => s.currentPath)
  const loading = useFtpStore((s) => s.loading)
  const error = useFtpStore((s) => s.error)
  const setConnectionState = useFtpStore((s) => s.setConnectionState)
  const goBack = useFtpStore((s) => s.goBack)
  const goForward = useFtpStore((s) => s.goForward)
  const refresh = useFtpStore((s) => s.refresh)
  const viewMode = useSettingsStore((s) => s.remoteViewMode)
  const setViewMode = useSettingsStore((s) => s.setRemoteViewMode)
  const clearSelection = useSelectionStore((s) => s.clearSelection)
  const clearRemoteFolderPreviews = useGalleryStore((s) => s.clearRemote)

  const [isDragOver, setIsDragOver] = useState(false)
  // Remote folder path currently hovered during a drag (drop lands inside it).
  const [dragOverFolderPath, setDragOverFolderPath] = useState<string | null>(null)
  const dragCounterRef = useRef(0)

  // 디렉토리 변경 시 선택 해제 + 대기 중인 썸네일/폴더 preview 요청 취소 + 캐시 무효화
  useEffect(() => {
    clearSelection()
    window.api.invoke('thumbnail:cancelAll')
    window.api.invoke('gallery:cancelAll')
    clearRemoteFolderPreviews()
  }, [currentPath, clearSelection, clearRemoteFolderPreviews])

  useEffect(() => {
    const unsubscribe = window.api.on('ftp:connectionStatus', (...args: unknown[]) => {
      const state = args[0] as FtpConnectionState
      setConnectionState(state)
    })
    return unsubscribe
  }, [setConnectionState])

  const handleMouseUp = (e: React.MouseEvent): void => {
    if (e.button === 3) {
      e.preventDefault()
      goBack()
    } else if (e.button === 4) {
      e.preventDefault()
      goForward()
    }
  }

  const handleKeyDown = async (e: React.KeyboardEvent): Promise<void> => {
    if (e.key !== 'Delete') return
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      (e.target instanceof HTMLElement && e.target.isContentEditable)
    ) {
      return
    }
    e.preventDefault()
    e.stopPropagation()

    const sel = useSelectionStore.getState().selectedNames
    if (sel.size === 0) return
    const allEntries = useFtpStore.getState().entries
    const targets = allEntries.filter((en) => sel.has(en.name))
    if (targets.length === 0) return

    const confirmBeforeDelete = useSettingsStore.getState().confirmBeforeDelete
    const msg =
      targets.length === 1 ? `Delete "${targets[0].name}"?` : `Delete ${targets.length} items?`
    if (confirmBeforeDelete && !window.confirm(msg)) return

    const path = useFtpStore.getState().currentPath
    const deleteTargets: DeleteTarget[] = targets.map((t) => ({
      path: path === '/' ? `/${t.name}` : `${path}/${t.name}`,
      isDirectory: t.type === 'directory'
    }))
    try {
      const result = await window.api.invoke<IpcResult<void>>('ftp:deleteBatch', deleteTargets)
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
    }
  }

  const isAcceptableDrag = (e: React.DragEvent): boolean => {
    return (
      e.dataTransfer.types.includes('application/x-remote-files') ||
      e.dataTransfer.types.includes('application/x-local-files') ||
      e.dataTransfer.types.includes('Files')
    )
  }

  // Remote folder under the cursor, or null when over empty space / a file.
  const folderPathFromEvent = (e: React.DragEvent): string | null => {
    if (!(e.target instanceof Element)) return null
    return e.target.closest('[data-folder-path]')?.getAttribute('data-folder-path') ?? null
  }

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!isAcceptableDrag(e)) return
    // Remote→remote is a move; uploads from local/OS are copies.
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes('application/x-remote-files')
      ? 'move'
      : 'copy'
    setDragOverFolderPath(folderPathFromEvent(e))
  }

  const handleDragEnter = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (isAcceptableDrag(e)) {
      setIsDragOver(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDragOver(false)
      setDragOverFolderPath(null)
    }
  }

  const handleDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragOver(false)
    setDragOverFolderPath(null)

    // Drop into the hovered folder when there is one, else the current directory.
    const targetPath = folderPathFromEvent(e) ?? useFtpStore.getState().currentPath

    try {
      await performRemoteDrop(e.dataTransfer, targetPath)
    } catch (err) {
      toast.error('Failed to handle drop', {
        description: err instanceof Error ? err.message : String(err)
      })
    }
  }

  // Clear drag feedback when a drag started inside this panel ends without a drop
  // (e.g. cancelled with Escape while still hovering — no dragleave/drop fires).
  const handleDragEnd = (): void => {
    dragCounterRef.current = 0
    setIsDragOver(false)
    setDragOverFolderPath(null)
  }

  if (connectionStatus !== 'connected') {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center border-b border-gray-200 bg-gray-100 px-3 py-1 text-xs font-medium text-gray-500">
          REMOTE
        </div>
        <div className="flex flex-1 items-center justify-center text-gray-400">
          <div className="text-center">
            <p className="text-sm">Not connected</p>
            <p className="mt-1 text-xs text-gray-300">
              Click &quot;Connect&quot; to connect to an FTP server
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      tabIndex={0}
      className={`relative flex h-full flex-col focus:outline-none ${isDragOver ? 'ring-2 ring-inset ring-blue-400' : ''}`}
      onMouseUp={handleMouseUp}
      onKeyDown={handleKeyDown}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragEnd={handleDragEnd}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between border-b border-gray-200 bg-gray-100 px-3 py-1">
        <span className="text-xs font-medium text-gray-500">REMOTE</span>
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
      </div>
      <RemoteBreadcrumb />
      {error && <div className="bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-blue-50/50">
          <div className="rounded-lg bg-blue-100 px-6 py-4 text-sm font-medium text-blue-700 shadow">
            Drop files here to upload
          </div>
        </div>
      )}
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-sm text-gray-400">Loading...</div>
        </div>
      ) : viewMode === 'list' ? (
        <FileListView dragOverFolderPath={dragOverFolderPath} />
      ) : (
        <FileGridView gallery={viewMode === 'gallery'} dragOverFolderPath={dragOverFolderPath} />
      )}
    </div>
  )
}
