import { useEffect, useRef, useState } from 'react'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { formatBytes } from '@renderer/lib/utils'
import type { TransferJob, TransferProgress } from '@shared/types/transfer'

interface TransferGroup {
  key: string
  jobs: TransferJob[]
  isBatch: boolean
}

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

function percent(transferred: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((transferred / total) * 100)))
}

function groupJobs(jobs: TransferJob[]): TransferGroup[] {
  const groups = new Map<string, TransferGroup>()

  for (const job of jobs) {
    const key = job.batchId ? `batch:${job.batchId}` : `job:${job.id}`
    const existing = groups.get(key)
    if (existing) {
      existing.jobs.push(job)
    } else {
      groups.set(key, { key, jobs: [job], isBatch: job.batchId !== undefined })
    }
  }

  return [...groups.values()]
}

function batchStatus(jobs: TransferJob[]): TransferJob['status'] {
  if (jobs.some((job) => job.status === 'active')) return 'active'
  if (jobs.some((job) => job.status === 'pending')) return 'pending'
  if (jobs.some((job) => job.status === 'failed')) return 'failed'
  if (jobs.some((job) => job.status === 'cancelled')) return 'cancelled'
  return 'completed'
}

function ProgressBar({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className="h-1.5 flex-1 rounded-full bg-gray-200"
    >
      <div
        className="h-1.5 rounded-full bg-blue-500 transition-all"
        style={{ width: `${value}%` }}
      />
    </div>
  )
}

function JobRow({
  job,
  nested = false,
  cancel
}: {
  job: TransferJob
  nested?: boolean
  cancel: (id: string) => Promise<void>
}): React.JSX.Element {
  const jobPercent = percent(job.transferredBytes, job.totalBytes)

  return (
    <div className={`flex items-center gap-2 py-1.5 pr-3 text-xs ${nested ? 'pl-7' : 'pl-3'}`}>
      <span className="text-gray-400">{nested ? '↳' : job.direction === 'upload' ? '↑' : '↓'}</span>
      <span className="min-w-0 flex-1 truncate" title={job.fileName}>
        {job.fileName}
      </span>
      {job.status === 'active' && (
        <div className="flex w-32 items-center gap-1">
          <ProgressBar label={`${job.fileName} progress`} value={jobPercent} />
          <span className="w-8 text-right text-gray-500">{jobPercent}%</span>
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
          type="button"
          aria-label={`Cancel ${job.fileName}`}
          className="text-gray-400 hover:text-red-500"
          onClick={() => void cancel(job.id)}
        >
          ✕
        </button>
      )}
    </div>
  )
}

function BatchRows({
  jobs,
  cancel
}: {
  jobs: TransferJob[]
  cancel: (id: string) => Promise<void>
}): React.JSX.Element {
  const status = batchStatus(jobs)
  const totalBytes = jobs.reduce((sum, job) => sum + job.totalBytes, 0)
  const transferredBytes = jobs.reduce(
    (sum, job) =>
      sum +
      (job.status === 'completed'
        ? job.totalBytes
        : Math.min(job.totalBytes, Math.max(0, job.transferredBytes))),
    0
  )
  const overallPercent =
    totalBytes > 0
      ? percent(transferredBytes, totalBytes)
      : percent(jobs.filter((job) => job.status === 'completed').length, jobs.length)
  const completedCount = jobs.filter((job) => job.status === 'completed').length
  const currentJob = jobs.find((job) => job.status === 'active')
  const isLive = status === 'active' || status === 'pending'
  const direction = jobs[0].direction

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <span className="text-gray-400">{direction === 'upload' ? '↑' : '↓'}</span>
        <span className="min-w-0 flex-1 truncate">
          Overall ({completedCount}/{jobs.length} files)
        </span>
        {isLive && (
          <div className="flex w-32 items-center gap-1">
            <ProgressBar label="Overall transfer progress" value={overallPercent} />
            <span className="w-8 text-right text-gray-500">{overallPercent}%</span>
          </div>
        )}
        {isLive && (
          <span className="text-gray-400">
            {formatBytes(transferredBytes)} / {formatBytes(totalBytes)}
          </span>
        )}
        <span className={statusColor(status)}>{status}</span>
        {isLive && (
          <button
            type="button"
            aria-label="Cancel transfer batch"
            className="text-gray-400 hover:text-red-500"
            onClick={() => {
              for (const job of jobs) {
                if (job.status === 'active' || job.status === 'pending') void cancel(job.id)
              }
            }}
          >
            ✕
          </button>
        )}
      </div>
      {currentJob && <JobRow job={currentJob} nested cancel={cancel} />}
    </div>
  )
}

export function TransferPanel(): React.JSX.Element {
  const jobs = useTransferStore((s) => s.jobs)
  const setJobs = useTransferStore((s) => s.setJobs)
  const updateProgress = useTransferStore((s) => s.updateProgress)
  const clearCompleted = useTransferStore((s) => s.clearCompleted)
  const cancel = useTransferStore((s) => s.cancel)
  const [collapsed, setCollapsed] = useState(true)
  const prevActiveCount = useRef(0)

  useEffect(() => {
    const unsubUpdated = window.api.on('transfer:updated', (...args: unknown[]) => {
      const next = args[0] as TransferJob[]
      setJobs(next)
      // Auto-expand only when a new run starts, so manually collapsing an
      // in-progress transfer remains respected.
      const active = next.filter(
        (job) => job.status === 'active' || job.status === 'pending'
      ).length
      if (active > 0 && prevActiveCount.current === 0) {
        setCollapsed(false)
      }
      prevActiveCount.current = active
    })
    const unsubProgress = window.api.on('transfer:progress', (...args: unknown[]) => {
      updateProgress(args[0] as TransferProgress)
    })
    return () => {
      unsubUpdated()
      unsubProgress()
    }
  }, [setJobs, updateProgress])

  const activeCount = jobs.filter(
    (job) => job.status === 'active' || job.status === 'pending'
  ).length
  const groups = groupJobs(jobs)

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
          {jobs.some(
            (job) =>
              job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
          ) && (
            <button
              type="button"
              className="text-gray-400 hover:text-gray-600"
              onClick={(event) => {
                event.stopPropagation()
                void clearCompleted()
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
          {groups.map((group) =>
            group.isBatch ? (
              <BatchRows key={group.key} jobs={group.jobs} cancel={cancel} />
            ) : (
              <JobRow key={group.key} job={group.jobs[0]} cancel={cancel} />
            )
          )}
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
