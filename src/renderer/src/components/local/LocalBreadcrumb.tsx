import { useState, useRef } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { splitLocalPath, buildLocalPath, getRootLabel, getRootPath } from '@renderer/lib/localPath'

export function LocalBreadcrumb(): React.JSX.Element {
  const currentPath = useLocalFsStore((s) => s.currentPath)
  const navigateTo = useLocalFsStore((s) => s.navigateTo)
  const historyIndex = useLocalFsStore((s) => s.historyIndex)
  const history = useLocalFsStore((s) => s.history)
  const goBack = useLocalFsStore((s) => s.goBack)
  const goForward = useLocalFsStore((s) => s.goForward)
  const [editing, setEditing] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const canGoBack = historyIndex > 0
  const canGoForward = historyIndex < history.length - 1

  const parts = splitLocalPath(currentPath)
  const rootLabel = getRootLabel(currentPath)

  const handleClick = (index: number): void => {
    const path = buildLocalPath(currentPath, parts, index)
    navigateTo(path)
  }

  const handleEditStart = (): void => {
    setInputValue(currentPath)
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  const handleEditSubmit = async (): Promise<void> => {
    setEditing(false)
    const path = inputValue.trim()
    if (!path) return
    await navigateTo(path)
    const error = useLocalFsStore.getState().error
    if (error) {
      toast.error(`Failed to navigate to "${path}"`, { description: error })
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') handleEditSubmit()
    if (e.key === 'Escape') setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center border-b border-gray-200 bg-gray-50 px-1.5 py-1.5">
        <button disabled className="rounded p-0.5 text-gray-300">
          <ChevronLeft size={14} />
        </button>
        <button disabled className="mr-1 rounded p-0.5 text-gray-300">
          <ChevronRight size={14} />
        </button>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={handleEditSubmit}
          onKeyDown={handleKeyDown}
          className="w-full rounded border border-blue-400 bg-white px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          autoFocus
        />
      </div>
    )
  }

  return (
    <div
      className="flex items-center gap-0.5 overflow-x-auto border-b border-gray-200 bg-gray-50 px-1.5 py-1.5 text-sm"
      onDoubleClick={handleEditStart}
    >
      <button
        onClick={goBack}
        disabled={!canGoBack}
        className={`rounded p-0.5 ${canGoBack ? 'text-gray-600 hover:bg-gray-200 hover:text-gray-900' : 'text-gray-300'}`}
        title="Back"
      >
        <ChevronLeft size={14} />
      </button>
      <button
        onClick={goForward}
        disabled={!canGoForward}
        className={`mr-1 rounded p-0.5 ${canGoForward ? 'text-gray-600 hover:bg-gray-200 hover:text-gray-900' : 'text-gray-300'}`}
        title="Forward"
      >
        <ChevronRight size={14} />
      </button>
      <button
        onClick={() => navigateTo(getRootPath(currentPath))}
        className="shrink-0 rounded px-1.5 py-0.5 text-gray-600 hover:bg-gray-200 hover:text-gray-900"
      >
        {rootLabel}
      </button>
      {parts.map((part, i) => {
        // Windows: 첫 번째 part가 드라이브 "C:" 이면 루트 버튼과 중복이므로 스킵
        if (i === 0 && rootLabel !== '/') return null
        return (
          <span key={i} className="flex shrink-0 items-center">
            <span className="text-gray-400">/</span>
            <button
              onClick={() => handleClick(i)}
              className="rounded px-1.5 py-0.5 text-gray-700 hover:bg-gray-200 hover:text-gray-900"
            >
              {part}
            </button>
          </span>
        )
      })}
    </div>
  )
}
