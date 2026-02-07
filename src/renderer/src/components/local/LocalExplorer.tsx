import { useEffect } from 'react'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { LocalBreadcrumb } from './LocalBreadcrumb'
import { LocalFileList } from './LocalFileList'

export function LocalExplorer(): React.JSX.Element {
  const init = useLocalFsStore((s) => s.init)
  const loading = useLocalFsStore((s) => s.loading)
  const error = useLocalFsStore((s) => s.error)
  const currentPath = useLocalFsStore((s) => s.currentPath)

  useEffect(() => {
    if (!currentPath) {
      init()
    }
  }, [currentPath, init])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center border-b border-gray-200 bg-gray-100 px-3 py-1 text-xs font-medium text-gray-500">
        LOCAL
      </div>
      {currentPath && <LocalBreadcrumb />}
      {error && <div className="bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
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
