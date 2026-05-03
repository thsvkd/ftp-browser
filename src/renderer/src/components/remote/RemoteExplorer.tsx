import { useEffect, useState, useRef } from 'react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useSelectionStore } from '@renderer/stores/useSelectionStore'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useGalleryStore } from '@renderer/stores/useGalleryStore'
import { RemoteBreadcrumb } from './RemoteBreadcrumb'
import { FileListView } from './FileListView'
import { FileGridView } from './FileGridView'
import { ViewModeToggle } from '@renderer/components/common/ViewModeToggle'
import { toast } from 'sonner'
import type { FtpConnectionState } from '@shared/types/ftp'

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
  const enqueue = useTransferStore((s) => s.enqueue)
  const clearRemoteFolderPreviews = useGalleryStore((s) => s.clearRemote)

  const [isDragOver, setIsDragOver] = useState(false)
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

    const msg =
      targets.length === 1 ? `Delete "${targets[0].name}"?` : `Delete ${targets.length} items?`
    if (!window.confirm(msg)) return

    const path = useFtpStore.getState().currentPath
    try {
      for (const t of targets) {
        const remotePath = path === '/' ? `/${t.name}` : `${path}/${t.name}`
        await window.api.invoke('ftp:delete', remotePath, t.type === 'directory')
      }
    } catch (err) {
      toast.error('Failed to delete', {
        description: err instanceof Error ? err.message : String(err)
      })
    } finally {
      refresh()
    }
  }

  const isAcceptableDrag = (e: React.DragEvent): boolean => {
    return (
      e.dataTransfer.types.includes('application/x-local-files') ||
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

    const path = useFtpStore.getState().currentPath

    try {
      // Intra-app drag from local panel
      const localFilesData = e.dataTransfer.getData('application/x-local-files')
      if (localFilesData) {
        const localFiles = JSON.parse(localFilesData) as Array<{
          localPath: string
          fileName: string
          size: number
        }>
        for (const file of localFiles) {
          const remotePath = path === '/' ? `/${file.fileName}` : `${path}/${file.fileName}`
          await enqueue('upload', file.localPath, remotePath, file.fileName, file.size)
        }
        return
      }

      // Native file drop (from OS file explorer). Electron 32+ requires webUtils.
      const files = Array.from(e.dataTransfer.files)
      for (const file of files) {
        const localPath = window.api.getPathForFile(file)
        if (!localPath) continue
        const fileName = file.name
        const remotePath = path === '/' ? `/${fileName}` : `${path}/${fileName}`
        await enqueue('upload', localPath, remotePath, fileName, file.size)
      }
    } catch (err) {
      toast.error('Failed to enqueue upload', {
        description: err instanceof Error ? err.message : String(err)
      })
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
        <FileListView />
      ) : (
        <FileGridView gallery={viewMode === 'gallery'} />
      )}
    </div>
  )
}
