import { useEffect, useState } from 'react'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { formatBytes } from '@renderer/lib/utils'
import type { TransferJob, TransferProgress } from '@shared/types/transfer'

function statusColor(status: TransferJob['status']): string {
  switch (status) {
    case 'active':
      return 'text-blue-600'
    case 'completed':
      return 'text-green-600'
    case 'failed':
      return 'text-red-600'
    case 'cancelled':
      return 'text-gray-400'
    default:
      return 'text-gray-500'
  }
}

export function TransferPanel(): React.JSX.Element {
  const jobs = useTransferStore((s) => s.jobs)
  const setJobs = useTransferStore((s) => s.setJobs)
  const updateProgress = useTransferStore((s) => s.updateProgress)
  const clearCompleted = useTransferStore((s) => s.clearCompleted)
  const cancel = useTransferStore((s) => s.cancel)
  const [collapsed, setCollapsed] = useState(true)

  useEffect(() => {
    const unsubUpdated = window.api.on('transfer:updated', (...args: unknown[]) => {
      setJobs(args[0] as TransferJob[])
    })
    const unsubProgress = window.api.on('transfer:progress', (...args: unknown[]) => {
      updateProgress(args[0] as TransferProgress)
    })
    return () => {
      unsubUpdated()
      unsubProgress()
    }
  }, [setJobs, updateProgress])

  const activeCount = jobs.filter((j) => j.status === 'active' || j.status === 'pending').length

  return (
    <div className="border-t border-gray-200 bg-white">
      <div
        className="flex cursor-pointer items-center justify-between px-3 py-1.5 text-xs hover:bg-gray-50"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="font-medium text-gray-600">
          Transfers {activeCount > 0 && `(${activeCount} active)`}
        </span>
        <div className="flex items-center gap-2">
          {jobs.some((j) => j.status === 'completed' || j.status === 'failed') && (
            <button
              className="text-gray-400 hover:text-gray-600"
              onClick={(e) => {
                e.stopPropagation()
                clearCompleted()
              }}
            >
              Clear
            </button>
          )}
          <span className="text-gray-400">{collapsed ? '▲' : '▼'}</span>
        </div>
      </div>

      {!collapsed && jobs.length > 0 && (
        <div className="max-h-40 overflow-auto border-t border-gray-100">
          {jobs.map((job) => {
            const percent =
              job.totalBytes > 0
                ? Math.round((job.transferredBytes / job.totalBytes) * 100)
                : 0

            return (
              <div key={job.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <span className="text-gray-400">
                  {job.direction === 'upload' ? '↑' : '↓'}
                </span>
                <span className="min-w-0 flex-1 truncate" title={job.fileName}>
                  {job.fileName}
                </span>
                {job.status === 'active' && (
                  <div className="flex w-32 items-center gap-1">
                    <div className="h-1.5 flex-1 rounded-full bg-gray-200">
                      <div
                        className="h-1.5 rounded-full bg-blue-500 transition-all"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    <span className="w-8 text-right text-gray-500">{percent}%</span>
                  </div>
                )}
                {job.status === 'active' && (
                  <span className="text-gray-400">
                    {formatBytes(job.transferredBytes)} / {formatBytes(job.totalBytes)}
                  </span>
                )}
                <span className={statusColor(job.status)}>{job.status}</span>
                {(job.status === 'pending' || job.status === 'active') && (
                  <button
                    className="text-gray-400 hover:text-red-500"
                    onClick={() => cancel(job.id)}
                  >
                    ✕
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {!collapsed && jobs.length === 0 && (
        <div className="border-t border-gray-100 px-3 py-3 text-center text-xs text-gray-400">
          No transfers
        </div>
      )}
    </div>
  )
}
