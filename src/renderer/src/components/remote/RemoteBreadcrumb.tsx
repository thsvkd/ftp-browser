import { useState, useRef } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useFtpStore } from '@renderer/stores/useFtpStore'

export function RemoteBreadcrumb(): React.JSX.Element {
  const currentPath = useFtpStore((s) => s.currentPath)
  const navigateTo = useFtpStore((s) => s.navigateTo)
  const historyIndex = useFtpStore((s) => s.historyIndex)
  const history = useFtpStore((s) => s.history)
  const goBack = useFtpStore((s) => s.goBack)
  const goForward = useFtpStore((s) => s.goForward)

  const [editing, setEditing] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const canGoBack = historyIndex > 0
  const canGoForward = historyIndex < history.length - 1

  const parts = currentPath.split('/').filter(Boolean)

  const handleClick = (index: number): void => {
    const path = '/' + parts.slice(0, index + 1).join('/')
    navigateTo(path)
  }

  const handleEditStart = (): void => {
    setInputValue(currentPath)
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  const handleEditSubmit = (): void => {
    setEditing(false)
    const path = inputValue.trim() || '/'
    navigateTo(path.startsWith('/') ? path : '/' + path)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') handleEditSubmit()
    if (e.key === 'Escape') setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center border-b border-gray-200 bg-gray-50 px-1.5 py-1.5">
        <button
          disabled
          className="rounded p-0.5 text-gray-300"
        >
          <ChevronLeft size={14} />
        </button>
        <button
          disabled
          className="mr-1 rounded p-0.5 text-gray-300"
        >
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
      className="flex items-center gap-0.5 border-b border-gray-200 bg-gray-50 px-1.5 py-1.5 text-sm"
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
        onClick={() => navigateTo('/')}
        className="rounded px-1.5 py-0.5 text-gray-600 hover:bg-gray-200 hover:text-gray-900"
      >
        /
      </button>
      {parts.map((part, i) => (
        <span key={i} className="flex items-center">
          <span className="text-gray-400">/</span>
          <button
            onClick={() => handleClick(i)}
            className="rounded px-1.5 py-0.5 text-gray-700 hover:bg-gray-200 hover:text-gray-900"
          >
            {part}
          </button>
        </span>
      ))}
    </div>
  )
}
