import { useId, useMemo, useRef } from 'react'
import { ChevronDown, Loader, RotateCw, X } from 'lucide-react'
import { useT } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'
import { batchProgress, formatDuration, type RateSample } from '@renderer/lib/transferRate'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import {
  batchIconState,
  groupJobs,
  groupStatus,
  isLive,
  locText,
  speedOf,
  statusKey,
  type JobGroup
} from './activityJobs'
import { BatchIcon, ICON_BTN, ProgressBar } from './activityUi'

/**
 * 전송 패널(P1~P3): 오른쪽 아래에 뜨는 진행 상황. 새 보내기가 시작되면 펼친 채로 열리고, 모두 끝나도
 * 완료 요약으로 남아 사람이 닫을 때까지 있다. 파일 작업(복사·이동·삭제)은 보이지 않는다.
 * 어떤 행을 보일지는 스토어의 `panel`이 정한다(P2). 여기서는 그리기만 한다.
 */
export function TransferPanel(): React.JSX.Element | null {
  const t = useT()
  const bodyId = useId()
  const jobs = useTransferStore((s) => s.jobs)
  const batchMeta = useTransferStore((s) => s.batchMeta)
  const rates = useTransferStore((s) => s.rates)
  const pendingSends = useTransferStore((s) => s.pendingSends)
  const panel = useTransferStore((s) => s.panel)
  const groups = useMemo(() => groupJobs(jobs, batchMeta), [jobs, batchMeta])
  const regionRef = useRef<HTMLDivElement>(null)

  const rows = new Set(panel.rows)
  const pendingRows = pendingSends.filter((p) => rows.has(`send:${p.id}`))
  const groupRows = groups.filter((g) => rows.has(g.key))
  // 행이 0이어도(준비 → 첫 작업 틈) 열림·접힘은 스토어에 남는다(P2a).
  if (!panel.open || pendingRows.length + groupRows.length === 0) return null

  const runningGroups = groupRows.filter((g) => g.jobs.some(isLive))
  const runningCount = runningGroups.length + pendingRows.length
  const overall = batchProgress(runningGroups.flatMap((g) => g.jobs))
  const close = (): void => {
    // 키보드로 닫으면 포커스가 body로 떨어지지 않게 활동 알약으로 옮긴다.
    if (regionRef.current?.contains(document.activeElement))
      document.querySelector<HTMLElement>('[data-activity-target]')?.focus()
    useTransferStore.getState().closePanel()
  }

  let summary: string
  if (runningCount > 0) {
    const dirs = new Set(runningGroups.map((g) => g.jobs[0]?.direction))
    // 서버 간 복사는 올리기도 받기도 아니다: 섞인 것과 같이 "전송 중"
    const kind =
      runningGroups.length === 0
        ? 'preparing'
        : dirs.size > 1 || dirs.has('relay')
          ? 'transferring'
          : dirs.has('upload')
            ? 'uploading'
            : 'downloading'
    summary = t(`transferPanel.${kind}`, { count: runningCount })
  } else {
    const count = (status: 'failed' | 'completed'): number =>
      groupRows.filter((g) => groupStatus(g.jobs) === status).length
    const failed = count('failed')
    const completed = count('completed')
    summary = failed
      ? t('transferPanel.failed', { count: failed })
      : completed
        ? t('transferPanel.completed', { count: completed })
        : t('transferPanel.cancelled', { count: groupRows.length })
  }

  const toggle = t(panel.collapsed ? 'transferPanel.expand' : 'transferPanel.collapse')

  return (
    <div
      ref={regionRef}
      role="region"
      aria-label={t('transferPanel.title')}
      className="rise fixed bottom-12 right-4 z-[45] w-[360px] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl border border-[var(--bd)] bg-[var(--sf)] text-[var(--tx)]"
      style={{ boxShadow: 'var(--shadow)' }}
    >
      <div className="pl-4 pr-2 pt-1.5">
        <div className="flex h-9 items-center gap-1">
          <div aria-live="polite" className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">
            {summary}
          </div>
          <button
            type="button"
            className={ICON_BTN}
            onClick={() => useTransferStore.getState().togglePanelCollapsed()}
            aria-label={t('transferPanel.list')}
            aria-expanded={!panel.collapsed}
            aria-controls={bodyId}
            title={toggle}
          >
            <ChevronDown
              className={cn(
                'h-4 w-4 transition-transform duration-200',
                panel.collapsed && 'rotate-180'
              )}
            />
          </button>
          <button
            type="button"
            className={ICON_BTN}
            onClick={close}
            aria-label={t('transferPanel.close')}
            title={t('transferPanel.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {runningGroups.length > 0 && (
          <div className="pb-3 pr-2">
            <ProgressBar label={t('transfer.overallProgress')} value={overall.percent} />
          </div>
        )}
      </div>
      {!panel.collapsed ? (
        <div
          id={bodyId}
          className="scroll max-h-[min(320px,50vh)] overflow-y-auto border-t border-[var(--bd)] p-1.5"
        >
          {pendingRows.map((p) => (
            <div key={p.id} className="flex items-center gap-3 rounded-xl px-2.5 py-2 text-[13px]">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--acw)] text-[var(--ac)]">
                <Loader className="spin h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1 truncate text-[var(--mu)]">
                {t('activity.preparing', { label: p.label })}
              </span>
            </div>
          ))}
          {groupRows.map((g) => (
            <Row key={g.key} group={g} rates={rates} />
          ))}
        </div>
      ) : (
        <span id={bodyId} hidden />
      )}
    </div>
  )
}

function Row({
  group,
  rates
}: {
  group: JobGroup
  rates: Record<string, RateSample>
}): React.JSX.Element {
  const t = useT()
  const { jobs, label, to } = group
  const running = jobs.some(isLive)
  const failed = jobs.filter((j) => j.status === 'failed')
  const progress = batchProgress(jobs)
  const finishing = statusKey(jobs) === 'job.finishing'
  const { eta } = speedOf(jobs, rates)
  const remaining = finishing
    ? t('job.finishing')
    : eta !== null
      ? t('activity.remaining', { time: formatDuration(eta) })
      : null
  const isFailed = batchIconState(jobs) === 'failed'

  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-start gap-3 rounded-xl px-2.5 py-2 hover:bg-[var(--hv)]"
    >
      <span
        className={cn(
          'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]',
          isFailed ? 'bg-[var(--dgw)]' : 'bg-[var(--acw)]'
        )}
      >
        <BatchIcon jobs={jobs} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={label}>
            {label}
          </span>
          {failed.length > 0 && (
            <button
              type="button"
              className={cn(ICON_BTN, '-my-1 -mr-1')}
              onClick={() => void useTransferStore.getState().retry(failed.map((j) => j.id))}
              aria-label={t('activity.retry')}
              title={t('activity.retry')}
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="truncate text-[11.5px] text-[var(--mu)]" title={to.path}>
          → {locText(to, t)}
        </div>
        {running ? (
          <>
            <div className="mt-1.5">
              <ProgressBar
                label={t('transfer.fileProgress', { name: label })}
                value={progress.percent}
                tone={failed.length ? 'bg-[var(--dg)]' : 'bg-[var(--ac)]'}
              />
            </div>
            <div className="mono mt-1 flex gap-1.5 text-[11px] text-[var(--mu)]">
              <span>{progress.percent}%</span>
              {remaining && (
                <>
                  <span aria-hidden>·</span>
                  <span>{remaining}</span>
                </>
              )}
            </div>
          </>
        ) : (
          <div
            className={cn(
              'mt-0.5 text-[11.5px]',
              isFailed ? 'text-[var(--dg)]' : 'text-[var(--mu)]'
            )}
            title={isFailed ? failed[0]?.error : undefined}
          >
            {t(statusKey(jobs))}
          </div>
        )}
      </div>
    </div>
  )
}
