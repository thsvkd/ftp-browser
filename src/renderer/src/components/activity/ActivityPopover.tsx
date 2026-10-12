import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  FolderSearch,
  Loader,
  RotateCw,
  X
} from 'lucide-react'
import { getLocale, useT } from '@renderer/i18n'
import { useEscapeKey } from '@renderer/hooks/useEscapeKey'
import { cn, formatBytes } from '@renderer/lib/utils'
import { batchProgress, formatDuration, type RateSample } from '@renderer/lib/transferRate'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useOperationStore } from '@renderer/stores/useOperationStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import type { OperationJob } from '@shared/types/operation'
import type { TransferJob } from '@shared/types/transfer'
import {
  groupJobs,
  isLive,
  locText,
  speedOf,
  statusKey,
  topItemName,
  type JobGroup
} from './activityJobs'
import { BatchIcon, ICON_BTN, ProgressBar, TEXT_BTN } from './activityUi'

type T = ReturnType<typeof useT>

/**
 * 활동 팝오버(D17): 전송 묶음을 배치당 한 줄로 보이는 기록(진행·실패 사유·재시도·탭에서 보기)과 파일 작업.
 * 실행 중인 전송의 큰 진행은 오른쪽 아래 `TransferPanel`과 알약이 보인다.
 * 일시 정지는 없다(H2). 바깥 클릭·Esc로 닫고, Esc는 포커스를 알약으로 돌려준다.
 */
export function ActivityPopover({
  anchor,
  onClose
}: {
  anchor: HTMLElement | null
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const jobs = useTransferStore((s) => s.jobs)
  const batchMeta = useTransferStore((s) => s.batchMeta)
  const rates = useTransferStore((s) => s.rates)
  const pendingSends = useTransferStore((s) => s.pendingSends)
  const ops = useOperationStore((s) => s.jobs)
  const ref = useRef<HTMLDivElement>(null)
  const groups = useMemo(() => groupJobs(jobs, batchMeta), [jobs, batchMeta])
  // 알약 오른쪽 끝에 맞춰 아래에 연다. 창 밖으로 나가지 않게 자른다.
  const r = anchor?.getBoundingClientRect()
  const pos = r
    ? { left: Math.max(8, Math.min(r.right - 440, innerWidth - 448)), top: r.bottom + 8 }
    : { left: 8, top: 8 }

  useLayoutEffect(() => ref.current?.focus(), [])

  useEffect(() => {
    const down = (e: MouseEvent): void => {
      const target = e.target as Node
      if (!ref.current?.contains(target) && !anchor?.contains(target)) onClose()
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [anchor, onClose])

  useEscapeKey(() => {
    onClose()
    anchor?.focus()
  })

  const failedIds = jobs.filter((j) => j.status === 'failed').map((j) => j.id)

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('activity.title')}
      tabIndex={-1}
      onKeyDown={(e) => e.stopPropagation()}
      className="pop fixed z-[60] flex max-h-[70vh] w-[440px] flex-col overflow-hidden rounded-2xl border border-[var(--bd)] bg-[var(--sf)] text-[var(--tx)] outline-none"
      style={{ ...pos, boxShadow: 'var(--shadow)' }}
    >
      <div className="border-b border-[var(--bd)] px-4 py-3">
        <div className="flex items-center gap-1">
          <h2 className="flex-1 text-[15px] font-bold">{t('activity.title')}</h2>
          {failedIds.length > 0 && (
            <button
              type="button"
              onClick={() => void useTransferStore.getState().retry(failedIds)}
              className={cn(TEXT_BTN, 'text-[var(--dg)] hover:text-[var(--dg)]')}
            >
              <RotateCw className="h-3.5 w-3.5" />
              {t('activity.retryAllFailed', { count: failedIds.length })}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void useTransferStore.getState().clearCompleted()
              void useOperationStore.getState().clearFinished()
            }}
            className={TEXT_BTN}
          >
            {t('activity.clearCompleted')}
          </button>
        </div>
      </div>
      <div className="scroll min-h-0 flex-1 overflow-y-auto p-2">
        {!groups.length && !ops.length && !pendingSends.length && (
          <div className="px-6 py-10 text-center text-[13px] text-[var(--mu)]">
            <ArrowDownToLine className="mx-auto mb-2 h-6 w-6 opacity-60" aria-hidden />
            <p>{t('activity.empty')}</p>
            <p>{t('activity.emptyHint')}</p>
          </div>
        )}
        {pendingSends.map((p) => (
          <div
            key={p.id}
            className="flex min-h-[34px] items-center gap-2 rounded-[10px] px-2 py-1.5 text-[12.5px]"
          >
            <Loader className="spin h-4 w-4 shrink-0 text-[var(--ac)]" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[var(--mu)]">
              {t('activity.preparing', { label: p.label })}
            </span>
          </div>
        ))}
        {groups.map((g) => (
          <GroupRow key={g.key} group={g} rates={rates} onClose={onClose} />
        ))}
        {ops.length > 0 && <Operations ops={ops} />}
      </div>
    </div>
  )
}

/** 배치의 짧은 시각: 가장 늦은 `completedAt`, 없으면 가장 늦은 `startedAt`. 오늘이면 시:분, 아니면 월 일. */
function shortTime(jobs: readonly TransferJob[]): { iso: string; text: string } | null {
  const latest = (pick: (j: TransferJob) => string | undefined): string | undefined =>
    jobs
      .map(pick)
      .filter((v): v is string => !!v && !Number.isNaN(Date.parse(v)))
      .sort((x, y) => Date.parse(y) - Date.parse(x))[0]
  const iso = latest((j) => j.completedAt) ?? latest((j) => j.startedAt)
  if (!iso) return null
  const date = new Date(iso)
  const today = date.toDateString() === new Date().toDateString()
  const text = new Intl.DateTimeFormat(
    getLocale(),
    today ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric' }
  ).format(date)
  return { iso, text }
}

function GroupRow({
  group,
  rates,
  onClose
}: {
  group: JobGroup
  rates: Record<string, RateSample>
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const { jobs, label, to } = group
  const live = jobs.filter(isLive)
  const failed = jobs.filter((j) => j.status === 'failed')
  const done = jobs.filter((j) => j.status === 'completed')
  const [open, setOpen] = useState(jobs.length > 1 && failed.length > 0)
  const progress = batchProgress(jobs)
  const { speed, eta } = speedOf(jobs, rates)
  const key = statusKey(jobs)
  const retry = (ids: string[]): void => void useTransferStore.getState().retry(ids)
  const cancel = (id: string): void => void useTransferStore.getState().cancel(id)
  const showName = done[0] && topItemName(done[0], to)
  const time = live.length === 0 ? shortTime(jobs) : null
  const reason = jobs.length === 1 ? failed[0]?.error : undefined
  const btn = cn(ICON_BTN, 'h-6 w-6')

  return (
    <div
      role="group"
      aria-label={label}
      className="group min-h-[34px] rounded-[10px] px-2 py-1.5 hover:bg-[var(--hv)] focus-within:bg-[var(--hv)]"
    >
      <div className="flex min-h-[22px] items-center gap-2">
        <BatchIcon jobs={jobs} />
        <span
          className="min-w-[4rem] max-w-[40%] shrink truncate text-[12.5px] font-semibold"
          title={label}
        >
          {label}
        </span>
        {reason ? (
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--dg)]" title={reason}>
            {reason}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--mu)]" title={to.path}>
            → {locText(to, t)}
          </span>
        )}
        {live.length > 0 ? (
          <span className="flex min-w-0 shrink items-center gap-1.5">
            <span className="w-16 shrink-0">
              <ProgressBar
                label={t('transfer.fileProgress', { name: label })}
                value={progress.percent}
                tone={failed.length ? 'bg-[var(--dg)]' : 'bg-[var(--ac)]'}
              />
            </span>
            <span className="mono min-w-0 truncate text-[11px] text-[var(--mu)]">
              {progress.percent}%
              {speed > 0 && ` · ${t('activity.speed', { size: formatBytes(speed) })}`}
              {speed > 0 &&
                eta !== null &&
                ` · ${t('activity.remaining', { time: formatDuration(eta) })}`}
            </span>
          </span>
        ) : (
          <span className="mono min-w-0 shrink truncate whitespace-nowrap text-[11px] text-[var(--mu)]">
            {formatBytes(progress.totalBytes)}
            {jobs.length > 1 && ` · ${t('activity.fileCount', { count: jobs.length })}`}
            {time && (
              <>
                {' · '}
                <time dateTime={time.iso}>{time.text}</time>
              </>
            )}
          </span>
        )}
        <span
          className={cn(
            'shrink-0 text-[11px]',
            key === 'job.failed'
              ? 'text-[var(--dg)]'
              : key === 'job.finishing' || key === 'job.cancelled'
                ? 'text-[var(--mu)]'
                : 'sr-only'
          )}
        >
          {t(key)}
        </span>
        <span
          className={cn(
            'flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
            open && 'opacity-100'
          )}
        >
          {live.length > 0 && (
            <button
              type="button"
              className={btn}
              onClick={() => live.forEach((j) => cancel(j.id))}
              aria-label={t('transfer.cancelBatch')}
              title={t('transfer.cancelBatch')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          {failed.length > 0 && (
            <button
              type="button"
              className={btn}
              onClick={() => retry(failed.map((j) => j.id))}
              aria-label={t('activity.retry')}
              title={t('activity.retry')}
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          )}
          {done.length > 0 && (
            <button
              type="button"
              className={btn}
              onClick={() => {
                useTabsStore.getState().showInTab(to, showName)
                onClose()
              }}
              aria-label={t('activity.showInTab')}
              title={t('activity.showInTab')}
            >
              <FolderSearch className="h-3.5 w-3.5" />
            </button>
          )}
          {jobs.length > 1 && (
            <button
              type="button"
              className={btn}
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-label={t('activity.fileList')}
              title={t('activity.fileList')}
            >
              <ChevronDown
                className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
              />
            </button>
          )}
        </span>
      </div>
      {open && (
        <ul className="ml-6 mt-1 space-y-0.5 border-l border-[var(--bd)] pl-2">
          {jobs.map((j) => (
            <li key={j.id} className="flex items-center gap-2 py-1 text-[12px]">
              <span className="min-w-0 flex-1">
                <span className="block truncate" title={j.fileName}>
                  {j.fileName}
                </span>
                {j.error && (
                  <span className="mono block break-all text-[10.5px] text-[var(--dg)]">
                    {j.error}
                  </span>
                )}
              </span>
              <span className="mono shrink-0 text-[10.5px] text-[var(--mu)]">
                {j.status === 'active' ? `${batchProgress([j]).percent}%` : t(`job.${j.status}`)}
              </span>
              {isLive(j) && (
                <button
                  type="button"
                  className={ICON_BTN}
                  onClick={() => cancel(j.id)}
                  aria-label={t('transfer.cancelFile', { name: j.fileName })}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
              {j.status === 'failed' && (
                <button
                  type="button"
                  className={ICON_BTN}
                  onClick={() => retry([j.id])}
                  aria-label={t('activity.retryFile', { name: j.fileName })}
                >
                  <RotateCw className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function opSummary(job: OperationJob, t: T): string {
  const name = job.itemName
  const count = job.itemCount
  switch (job.kind) {
    case 'copy':
      return name ? t('operation.copyingNamed', { name }) : t('operation.copying', { count })
    case 'move':
      return name ? t('operation.movingNamed', { name }) : t('operation.moving', { count })
    case 'delete':
      return name ? t('operation.deletingNamed', { name }) : t('operation.deleting', { count })
  }
}

function opDetail(job: OperationJob, t: T): string {
  if (job.unit === 'bytes') return `${formatBytes(job.completed)} / ${formatBytes(job.total)}`
  return t('operation.fileProgress', { completed: job.completed, count: job.total })
}

const OP_ICON = {
  active: <Loader className="spin mt-0.5 h-4 w-4 shrink-0 text-[var(--ac)]" aria-hidden />,
  completed: <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ok)]" aria-hidden />,
  failed: <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--dg)]" aria-hidden />,
  cancelled: <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-[var(--mu)]" aria-hidden />
}

/** main `operation:*`(복사·이동·삭제)의 진행 */
function Operations({ ops }: { ops: OperationJob[] }): React.JSX.Element {
  const t = useT()
  return (
    <div role="group" aria-labelledby="activity-ops-title">
      <div
        id="activity-ops-title"
        className="px-2 pb-1 pt-3 text-[11.5px] font-bold text-[var(--mu)]"
      >
        {t('operation.title')}
      </div>
      {ops.map((op) => {
        const label = opSummary(op, t)
        const pct = op.total > 0 ? Math.round((op.completed / op.total) * 100) : 0
        return (
          <div
            key={op.id}
            className="flex items-start gap-2.5 rounded-[10px] px-2 py-2 text-[12.5px]"
          >
            {OP_ICON[op.status]}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate" title={op.currentItem ?? label}>
                  {label}
                </span>
                <span className="shrink-0 text-[11px] text-[var(--mu)]">
                  {t(`job.${op.status}`)}
                </span>
                {op.status === 'active' && (
                  <button
                    type="button"
                    className={ICON_BTN}
                    onClick={() => void useOperationStore.getState().cancel(op.id)}
                    aria-label={t('operation.cancel', { operation: label })}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {op.status === 'active' && (
                <>
                  <div className="mt-1">
                    <ProgressBar label={label} value={pct} />
                  </div>
                  <div className="mono mt-1 flex justify-between gap-2 text-[11px] text-[var(--mu)]">
                    <span className="truncate">{op.currentItem}</span>
                    <span className="shrink-0">{opDetail(op, t)}</span>
                  </div>
                </>
              )}
              {op.status === 'failed' && op.error && (
                <div className="mono mt-0.5 break-all text-[11px] text-[var(--dg)]">{op.error}</div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
