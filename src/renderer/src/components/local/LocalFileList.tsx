import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { formatBytes, formatDate } from '@renderer/lib/utils'
import type { LocalFileEntry } from '@shared/types/local'

function getFileIcon(entry: LocalFileEntry): string {
  if (entry.type === 'directory') return '📁'
  if (entry.isImage) return '🖼️'
  return '📄'
}

export function LocalFileList(): React.JSX.Element {
  const entries = useLocalFsStore((s) => s.entries)
  const currentPath = useLocalFsStore((s) => s.currentPath)
  const navigateTo = useLocalFsStore((s) => s.navigateTo)
  const navigateUp = useLocalFsStore((s) => s.navigateUp)

  const sorted = [...entries].sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1
    if (a.type !== 'directory' && b.type === 'directory') return 1
    return a.name.localeCompare(b.name)
  })

  const handleDoubleClick = (entry: LocalFileEntry): void => {
    if (entry.type === 'directory') {
      navigateTo(entry.path)
    }
  }

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 bg-gray-100 text-xs text-gray-500">
          <tr>
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="w-24 px-3 py-2 text-right font-medium">Size</th>
            <th className="w-44 px-3 py-2 font-medium">Modified</th>
          </tr>
        </thead>
        <tbody>
          {currentPath !== '/' && (
            <tr className="cursor-pointer hover:bg-blue-50" onDoubleClick={navigateUp}>
              <td className="px-3 py-1.5">
                <span className="mr-2">📁</span>
                <span className="text-gray-500">..</span>
              </td>
              <td />
              <td />
            </tr>
          )}
          {sorted.map((entry) => (
            <tr
              key={entry.name}
              className="cursor-pointer hover:bg-blue-50"
              onDoubleClick={() => handleDoubleClick(entry)}
            >
              <td className="px-3 py-1.5">
                <span className="mr-2">{getFileIcon(entry)}</span>
                <span className={entry.type === 'directory' ? 'font-medium' : ''}>
                  {entry.name}
                </span>
              </td>
              <td className="px-3 py-1.5 text-right text-gray-500">
                {entry.type === 'file' ? formatBytes(entry.size) : '--'}
              </td>
              <td className="px-3 py-1.5 text-gray-500">{formatDate(entry.modifiedAt)}</td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={3} className="px-3 py-8 text-center text-gray-400">
                Empty directory
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
