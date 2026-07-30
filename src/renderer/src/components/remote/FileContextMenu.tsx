import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useSelectionStore } from '@renderer/stores/useSelectionStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { clampMenuPosition, type MenuPlacement } from '@renderer/lib/menuPosition'
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
  const rootRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<MenuPlacement | null>(null)

  const handleClose = useCallback(() => {
    setEditing(null)
    onClose()
  }, [onClose])

  // D5·D6: 메뉴가 열릴 때 한 번만, 실제로 렌더된 크기를 재서 보정한다. 항목 구성에
  // 따라 높이가 달라지므로 상수로는 풀 수 없다. useEffect가 아니라 useLayoutEffect인
  // 이유는 페인트 전에 동기 실행되어 보정 전 좌표가 한 프레임 노출되는 깜빡임이
  // 없기 때문이다. deps가 position뿐이라 editing 전환처럼 내용만 바뀌는 재렌더에서는
  // 다시 재지 않는다 — Rename을 누를 때 메뉴가 튀는 것을 막는다.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!position || !root) {
      setPlacement(null)
      return
    }
    const rect = root.getBoundingClientRect()
    setPlacement(
      clampMenuPosition(
        position,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight }
      )
    )
  }, [position])

  // D9: 닫기 트리거 5종(바깥 좌클릭 / 바깥 우클릭 / Escape / 창 blur / 스크롤).
  // D8: Escape를 여기로 통합해 입력창 상태와 버튼 목록 상태가 같은 경로로 닫히게 한다.
  useEffect(() => {
    if (!position) return
    const handler = (): void => handleClose()
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    // 함정 1: 메뉴를 여는 우클릭의 native 이벤트는 이 리스너가 붙는 시점에도 아직
    // 전파 중이라, 그대로 두면 document까지 올라와 방금 연 메뉴를 즉시 닫는다.
    // 그 이벤트는 window의 capture 단계를 이미 지나간 뒤이므로, capture에서 본 적
    // 있는 이벤트만 닫기로 취급하면 자기충돌만 정확히 걸러진다.
    //
    // sentinel의 실제 의미는 "capture가 본 이벤트"가 아니라 "이 effect 인스턴스가
    // 살아 있는 동안 시작된 이벤트"다. 이미 열린 메뉴가 있는 패널의 빈 공간을 다시
    // 우클릭하면 position이 새 객체가 되어 discrete 커밋 -> passive effect 동기
    // flush(React의 sync-lane 규칙) 순으로 effect가 갈아끼워지고 sentinel이 null로
    // 초기화되므로, 메뉴는 닫히지 않고 새 위치로 이동한다. 이 경로를 "닫히는 버그"로
    // 오독해 sentinel을 걷어내지 말 것.
    //
    // 이 동작은 jsdom에서 재현되지 않는다(함정 4). 단위 테스트가 없으므로 검증은
    // 핸드오프 8절 E2E 체크리스트 (a)~(d)가 전담한다.
    let capturedContextMenu: Event | null = null
    const markContextMenu = (e: Event): void => {
      capturedContextMenu = e
    }
    const handleContextMenu = (e: Event): void => {
      if (capturedContextMenu !== e) return
      handleClose()
    }
    document.addEventListener('click', handler)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('contextmenu', markContextMenu, true)
    document.addEventListener('contextmenu', handleContextMenu)
    window.addEventListener('blur', handler)
    // 함정 2: 내부 스크롤 컨테이너의 scroll은 document로 버블링되지 않는다.
    // capture 단계로 등록해야 파일 목록 스크롤을 잡을 수 있다.
    window.addEventListener('scroll', handler, true)
    return () => {
      document.removeEventListener('click', handler)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('contextmenu', markContextMenu, true)
      document.removeEventListener('contextmenu', handleContextMenu)
      window.removeEventListener('blur', handler)
      window.removeEventListener('scroll', handler, true)
    }
  }, [position, handleClose])

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
      ref={rootRef}
      className="fixed z-50 min-w-[160px] rounded-md border border-gray-200 bg-white py-1 shadow-lg"
      // 첫 렌더는 앵커 그대로 두고 useLayoutEffect가 실측 후 보정한다. 보정은 페인트
      // 전에 끝나므로 잘린 위치가 화면에 보이지는 않는다.
      style={{ left: placement?.left ?? position.x, top: placement?.top ?? position.y }}
      onClick={(e) => e.stopPropagation()}
      // 함정 3: 메뉴 내부 우클릭이 document의 닫기 리스너까지 올라가지 않게 막는다.
      onContextMenu={(e) => e.stopPropagation()}
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
            // D8: Escape 분기는 document keydown 리스너로 통합했다. keydown은 버블링되므로
            // 입력창에서 누른 Escape도 그 리스너에 도달한다.
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitEdit()
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
