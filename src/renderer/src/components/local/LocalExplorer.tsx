import { useEffect, useState, useRef } from 'react'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { useLocalSelectionStore } from '@renderer/stores/useLocalSelectionStore'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useGalleryStore } from '@renderer/stores/useGalleryStore'
import { joinLocalPath } from '@renderer/lib/localPath'
import { toast } from 'sonner'
import type { DeleteTarget } from '@shared/types/operation'
import type { IpcResult } from '@shared/types/ipc'
import { LocalBreadcrumb } from './LocalBreadcrumb'
import { LocalFileList } from './LocalFileList'
import { LocalFileGridView } from './LocalFileGridView'
import { ViewModeToggle } from '@renderer/components/common/ViewModeToggle'

export function LocalExplorer(): React.JSX.Element {
  const init = useLocalFsStore((s) => s.init)
  const loading = useLocalFsStore((s) => s.loading)
  const error = useLocalFsStore((s) => s.error)
  const currentPath = useLocalFsStore((s) => s.currentPath)
  const goBack = useLocalFsStore((s) => s.goBack)
  const goForward = useLocalFsStore((s) => s.goForward)
  const refresh = useLocalFsStore((s) => s.refresh)
  const clearSelection = useLocalSelectionStore((s) => s.clearSelection)
  const enqueue = useTransferStore((s) => s.enqueue)
  const viewMode = useSettingsStore((s) => s.localViewMode)
  const setViewMode = useSettingsStore((s) => s.setLocalViewMode)
  const clearLocalFolderPreviews = useGalleryStore((s) => s.clearLocal)

  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  useEffect(() => {
    if (!currentPath) {
      init()
    }
  }, [currentPath, init])

  // Clear selection + folder preview cache on directory change
  useEffect(() => {
    clearSelection()
    clearLocalFolderPreviews()
  }, [currentPath, clearSelection, clearLocalFolderPreviews])

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

    const sel = useLocalSelectionStore.getState().selectedNames
    if (sel.size === 0) return
    const allEntries = useLocalFsStore.getState().entries
    const targets = allEntries.filter((en) => sel.has(en.name))
    if (targets.length === 0) return

    const confirmBeforeDelete = useSettingsStore.getState().confirmBeforeDelete
    const msg =
      targets.length === 1 ? `Delete "${targets[0].name}"?` : `Delete ${targets.length} items?`
    if (confirmBeforeDelete && !window.confirm(msg)) return

    const deleteTargets: DeleteTarget[] = targets.map((t) => ({
      path: t.path,
      isDirectory: t.type === 'directory'
    }))
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
    }
  }

  const isAcceptableDrag = (e: React.DragEvent): boolean => {
    return (
      e.dataTransfer.types.includes('application/x-remote-files') ||
      e.dataTransfer.types.includes('Files')
    )
  }

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (isAcceptableDrag(e)) {
      e.dataTransfer.dropEffect = 'copy'
    }
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
    }
  }

  const handleDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragOver(false)

    try {
      // Web drag from remote panel (custom MIME)
      const remoteFilesData = e.dataTransfer.getData('application/x-remote-files')
      if (remoteFilesData) {
        const remoteFiles = JSON.parse(remoteFilesData) as Array<{
          remotePath: string
          fileName: string
          size: number
        }>
        const localDir = useLocalFsStore.getState().currentPath
        for (const file of remoteFiles) {
          const localPath = joinLocalPath(localDir, file.fileName)
          await enqueue('download', localPath, file.remotePath, file.fileName, file.size)
        }
        return
      }

      // Native file drops (from remote panel native drag or OS file explorer).
      // Electron 32+ removed File.path; resolve via webUtils-backed bridge.
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) {
        const filePaths = files.map((f) => window.api.getPathForFile(f)).filter(Boolean)
        if (filePaths.length > 0) {
          const localDir = useLocalFsStore.getState().currentPath
          await window.api.invoke('local:copyFiles', filePaths, localDir)
          refresh()
        }
      }
    } catch (err) {
      toast.error('Failed to enqueue download', {
        description: err instanceof Error ? err.message : String(err)
      })
    }
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
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between border-b border-gray-200 bg-gray-100 px-3 py-1">
        <span className="text-xs font-medium text-gray-500">LOCAL</span>
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
      </div>
      {currentPath && <LocalBreadcrumb />}
      {error && <div className="bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-blue-50/50">
          <div className="rounded-lg bg-blue-100 px-6 py-4 text-sm font-medium text-blue-700 shadow">
            Drop files here to save
          </div>
        </div>
      )}
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-sm text-gray-400">Loading...</div>
        </div>
      ) : viewMode === 'list' ? (
        <LocalFileList />
      ) : (
        <LocalFileGridView gallery={viewMode === 'gallery'} />
      )}
    </div>
  )
}
