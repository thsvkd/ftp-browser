import { useEffect, useRef, useState } from 'react'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { formatBytes } from '@renderer/lib/utils'
import { useT } from '@renderer/i18n'
import type { TransferJob, TransferUpdate } from '@shared/types/transfer'
import type { IpcResult } from '@shared/types/ipc'

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
  const t = useT()

  return (
    <div className={`flex items-center gap-2 py-1.5 pr-3 text-xs ${nested ? 'pl-7' : 'pl-3'}`}>
      <span className="text-gray-400">{nested ? '↳' : job.direction === 'upload' ? '↑' : '↓'}</span>
      <span className="min-w-0 flex-1 truncate" title={job.fileName}>
        {job.fileName}
      </span>
      {job.status === 'active' && (
        <div className="flex w-32 items-center gap-1">
          <ProgressBar
            label={t('transfer.fileProgress', { name: job.fileName })}
            value={jobPercent}
          />
          <span className="w-8 text-right text-gray-500">{jobPercent}%</span>
        </div>
      )}
      {job.status === 'active' && (
        <span className="text-gray-400">
          {formatBytes(job.transferredBytes)} / {formatBytes(job.totalBytes)}
        </span>
      )}
      <span className={statusColor(job.status)}>{t(`job.${job.status}`)}</span>
      {(job.status === 'pending' || job.status === 'active') && (
        <button
          type="button"
          aria-label={t('transfer.cancelFile', { name: job.fileName })}
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
  const isLive = status === 'active' || status === 'pending'
  // 파일과 파일 사이(다음 파일 시작 전, 재시도 대기 중)나 대기 중인 배치에서도 두 번째 줄을
  // 유지해야 한다. 줄이 사라졌다 나타나면 전송 패널 높이가 떨린다.
  const currentJob = isLive
    ? (jobs.find((job) => job.status === 'active') ?? jobs.find((job) => job.status === 'pending'))
    : undefined
  const direction = jobs[0].direction
  const t = useT()

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <span className="text-gray-400">{direction === 'upload' ? '↑' : '↓'}</span>
        <span className="min-w-0 flex-1 truncate">
          {t('transfer.overall', { completed: completedCount, count: jobs.length })}
        </span>
        {isLive && (
          <div className="flex w-32 items-center gap-1">
            <ProgressBar label={t('transfer.overallProgress')} value={overallPercent} />
            <span className="w-8 text-right text-gray-500">{overallPercent}%</span>
          </div>
        )}
        {isLive && (
          <span className="text-gray-400">
            {formatBytes(transferredBytes)} / {formatBytes(totalBytes)}
          </span>
        )}
        <span className={statusColor(status)}>{t(`job.${status}`)}</span>
        {isLive && (
          <button
            type="button"
            aria-label={t('transfer.cancelBatch')}
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
  const applyUpdate = useTransferStore((s) => s.applyUpdate)
  const clearCompleted = useTransferStore((s) => s.clearCompleted)
  const cancel = useTransferStore((s) => s.cancel)
  const [collapsed, setCollapsed] = useState(true)
  const prevActiveCount = useRef(0)
  const t = useT()

  useEffect(() => {
    const unsubUpdated = window.api.on('transfer:updated', (...args: unknown[]) => {
      applyUpdate(args[0] as TransferUpdate)
      // Auto-expand only when a new run starts, so manually collapsing an
      // in-progress transfer remains respected.
      const active = useTransferStore
        .getState()
        .jobs.filter((job) => job.status === 'active' || job.status === 'pending').length
      if (active > 0 && prevActiveCount.current === 0) {
        setCollapsed(false)
      }
      prevActiveCount.current = active
    })
    // 변경분만 오므로, 렌더러가 늦게 뜨거나 새로고침돼도 기존 작업이 보이도록 처음 한 번 전체를 받는다.
    void window.api.invoke('transfer:getAll').then((result) => {
      const res = result as IpcResult<TransferJob[]> | undefined
      if (res?.success && res.data) applyUpdate({ upserts: res.data, removedIds: [] })
    })
    return unsubUpdated
  }, [applyUpdate])

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
          {activeCount > 0
            ? t('transfer.titleActive', { number: activeCount })
            : t('transfer.title')}
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
              {t('common.clear')}
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
          {t('transfer.empty')}
        </div>
      )}
    </div>
  )
}
