import { useEffect, useState, useRef } from 'react'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { useLocalSelectionStore } from '@renderer/stores/useLocalSelectionStore'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { joinLocalPath } from '@renderer/lib/localPath'
import { toast } from 'sonner'
import { LocalBreadcrumb } from './LocalBreadcrumb'
import { LocalFileList } from './LocalFileList'

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

  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  useEffect(() => {
    if (!currentPath) {
      init()
    }
  }, [currentPath, init])

  // Clear selection on directory change
  useEffect(() => {
    clearSelection()
  }, [currentPath, clearSelection])

  const handleMouseUp = (e: React.MouseEvent): void => {
    if (e.button === 3) {
      e.preventDefault()
      goBack()
    } else if (e.button === 4) {
      e.preventDefault()
      goForward()
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
      className={`relative flex h-full flex-col ${isDragOver ? 'ring-2 ring-inset ring-blue-400' : ''}`}
      onMouseUp={handleMouseUp}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-center border-b border-gray-200 bg-gray-100 px-3 py-1 text-xs font-medium text-gray-500">
        LOCAL
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
      ) : (
        <LocalFileList />
      )}
    </div>
  )
}
