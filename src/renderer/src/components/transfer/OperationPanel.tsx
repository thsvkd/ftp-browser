import { useEffect } from 'react'
import { Copy, FolderInput, Trash2, X } from 'lucide-react'
import { useOperationStore } from '@renderer/stores/useOperationStore'
import { formatBytes } from '@renderer/lib/utils'
import type { OperationJob, OperationProgress, OperationKind } from '@shared/types/operation'

function kindIcon(kind: OperationKind): React.JSX.Element {
  switch (kind) {
    case 'copy':
      return <Copy size={12} className="text-gray-400" />
    case 'move':
      return <FolderInput size={12} className="text-gray-400" />
    case 'delete':
      return <Trash2 size={12} className="text-gray-400" />
  }
}

function statusColor(status: OperationJob['status']): string {
  switch (status) {
    case 'active':
      return 'text-blue-600'
    case 'completed':
      return 'text-green-600'
    case 'failed':
      return 'text-red-600'
    case 'cancelled':
      return 'text-gray-400'
  }
}

function detail(job: OperationJob): string {
  if (job.unit === 'bytes') {
    return `${formatBytes(job.completed)} / ${formatBytes(job.total)}`
  }
  return `${job.completed} / ${job.total} files`
}

export function OperationPanel(): React.JSX.Element | null {
  const jobs = useOperationStore((s) => s.jobs)
  const setJobs = useOperationStore((s) => s.setJobs)
  const updateProgress = useOperationStore((s) => s.updateProgress)
  const cancel = useOperationStore((s) => s.cancel)
  const clearFinished = useOperationStore((s) => s.clearFinished)

  useEffect(() => {
    const unsubUpdated = window.api.on('operation:updated', (...args: unknown[]) => {
      setJobs(args[0] as OperationJob[])
    })
    const unsubProgress = window.api.on('operation:progress', (...args: unknown[]) => {
      updateProgress(args[0] as OperationProgress)
    })
    return () => {
      unsubUpdated()
      unsubProgress()
    }
  }, [setJobs, updateProgress])

  if (jobs.length === 0) return null

  const hasFinished = jobs.some((j) => j.status !== 'active')

  return (
    <div className="border-t border-gray-200 bg-white">
      <div className="flex items-center justify-between px-3 py-1.5 text-xs">
        <span className="font-medium text-gray-600">File operations</span>
        {hasFinished && (
          <button className="text-gray-400 hover:text-gray-600" onClick={() => clearFinished()}>
            Clear
          </button>
        )}
      </div>

      <div className="max-h-40 overflow-auto border-t border-gray-100">
        {jobs.map((job) => {
          const percent = job.total > 0 ? Math.round((job.completed / job.total) * 100) : 0

          return (
            <div key={job.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
              {kindIcon(job.kind)}
              <span className="min-w-0 flex-1 truncate" title={job.currentItem ?? job.label}>
                {job.label}
                {job.status === 'active' && job.currentItem && (
                  <span className="ml-1 text-gray-400">— {job.currentItem}</span>
                )}
                {job.status === 'failed' && job.error && (
                  <span className="ml-1 text-red-500">— {job.error}</span>
                )}
              </span>
              {job.status === 'active' && (
                <>
                  <div className="flex w-32 items-center gap-1">
                    <div className="h-1.5 flex-1 rounded-full bg-gray-200">
                      <div
                        className="h-1.5 rounded-full bg-blue-500 transition-all"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    <span className="w-8 text-right text-gray-500">{percent}%</span>
                  </div>
                  <span className="text-gray-400">{detail(job)}</span>
                </>
              )}
              <span className={statusColor(job.status)}>{job.status}</span>
              {job.status === 'active' && (
                <button className="text-gray-400 hover:text-red-500" onClick={() => cancel(job.id)}>
                  <X size={12} />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
