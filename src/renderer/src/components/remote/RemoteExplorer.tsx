import { useEffect, useState, useRef } from 'react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useSelectionStore } from '@renderer/stores/useSelectionStore'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { RemoteBreadcrumb } from './RemoteBreadcrumb'
import { FileListView } from './FileListView'
import { FileGridView } from './FileGridView'
import type { FtpConnectionState } from '@shared/types/ftp'

export function RemoteExplorer(): React.JSX.Element {
  const connectionStatus = useFtpStore((s) => s.connectionStatus)
  const currentPath = useFtpStore((s) => s.currentPath)
  const loading = useFtpStore((s) => s.loading)
  const error = useFtpStore((s) => s.error)
  const setConnectionState = useFtpStore((s) => s.setConnectionState)
  const viewMode = useSettingsStore((s) => s.viewMode)
  const toggleViewMode = useSettingsStore((s) => s.toggleViewMode)
  const clearSelection = useSelectionStore((s) => s.clearSelection)
  const enqueue = useTransferStore((s) => s.enqueue)

  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  // 디렉토리 변경 시 선택 해제 + 대기 중인 썸네일 요청 취소
  useEffect(() => {
    clearSelection()
    window.api.invoke('thumbnail:cancelAll')
  }, [currentPath, clearSelection])

  useEffect(() => {
    const unsubscribe = window.api.on('ftp:connectionStatus', (...args: unknown[]) => {
      const state = args[0] as FtpConnectionState
      setConnectionState(state)
    })
    return unsubscribe
  }, [setConnectionState])

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  const handleDragEnter = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
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

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragOver(false)

    const files = Array.from(e.dataTransfer.files)
    const path = useFtpStore.getState().currentPath
    for (const file of files) {
      const localPath = (file as File & { path: string }).path
      if (!localPath) continue
      const fileName = file.name
      const remotePath = path === '/' ? `/${fileName}` : `${path}/${fileName}`
      enqueue('upload', localPath, remotePath, fileName, file.size)
    }
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
      className={`flex h-full flex-col ${isDragOver ? 'ring-2 ring-inset ring-blue-400' : ''}`}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between border-b border-gray-200 bg-gray-100 px-3 py-1">
        <span className="text-xs font-medium text-gray-500">REMOTE</span>
        <button
          onClick={toggleViewMode}
          className="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-200"
          title={viewMode === 'list' ? 'Switch to grid view' : 'Switch to list view'}
        >
          {viewMode === 'list' ? '\u2630' : '\u2637'}
        </button>
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
      ) : viewMode === 'grid' ? (
        <FileGridView />
      ) : (
        <FileListView />
      )}
    </div>
  )
}
