import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, Loader } from 'lucide-react'
import { useT } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'
import { batchProgress } from '@renderer/lib/transferRate'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { connectedServer } from '@renderer/lib/sendItems'
import { useOperationStore } from '@renderer/stores/useOperationStore'
import type { IpcResult } from '@shared/types/ipc'
import type { OperationJob, OperationProgress } from '@shared/types/operation'
import type { TransferJob, TransferUpdate } from '@shared/types/transfer'
import { ActivityPopover } from './ActivityPopover'
import { runningJobs } from './activityJobs'

function Ring({ percent, active }: { percent: number; active: boolean }): React.JSX.Element {
  const size = 28
  const r = size / 2 - 2.5
  const c = 2 * Math.PI * r
  return (
    <svg width={size} height={size} className="absolute inset-0 -rotate-90" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bd)" strokeWidth={2.5} />
      {active && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--ac)"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - percent / 100)}
          style={{ transition: 'stroke-dashoffset .25s linear' }}
        />
      )}
    </svg>
  )
}

/**
 * 툴바 활동 알약(D17): 진행 고리·퍼센트·개수, 실패 수. 누르면 활동 팝오버.
 * 툴바에 늘 붙어 있으므로 `transfer:*`·`operation:*` 이벤트 구독도 여기서 한다(옛 두 패널의 몫).
 */
export function ActivityPill(): React.JSX.Element {
  const t = useT()
  const jobs = useTransferStore((s) => s.jobs)
  const running = useMemo(() => runningJobs(jobs), [jobs])
  const failed = jobs.filter((j) => j.status === 'failed').length
  const opsRunning = useOperationStore((s) => s.jobs.some((j) => j.status === 'active'))
  const [open, setOpen] = useState(false)
  const [button, setButton] = useState<HTMLButtonElement | null>(null)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    const applyUpdate = (update: TransferUpdate): void =>
      useTransferStore
        .getState()
        .applyUpdate(update, connectedServer(useFtpStore.getState()) ?? undefined)
    const { setJobs, updateProgress } = useOperationStore.getState()
    const unsubs = [
      window.api.on('transfer:updated', (...args: unknown[]) =>
        applyUpdate(args[0] as TransferUpdate)
      ),
      window.api.on('operation:updated', (...args: unknown[]) =>
        setJobs(args[0] as OperationJob[])
      ),
      window.api.on('operation:progress', (...args: unknown[]) =>
        updateProgress(args[0] as OperationProgress)
      )
    ]
    // 변경분만 오므로, 렌더러가 늦게 뜨거나 새로 고쳐져도 기존 작업이 보이도록 처음 한 번 전체를 받는다.
    void window.api.invoke<IpcResult<TransferJob[]>>('transfer:getAll').then((res) => {
      if (res?.success && res.data) applyUpdate({ upserts: res.data, removedIds: [] })
    })
    return () => unsubs.forEach((off) => off())
  }, [])

  const active = running.length > 0
  const progress = batchProgress(running)
  const Icon =
    running.every((j) => j.direction === 'upload') && active ? ArrowUpFromLine : ArrowDownToLine

  return (
    <>
      <button
        ref={setButton}
        type="button"
        data-activity-target
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        // 실패 수 배지는 숨겨진 장식이라 이름에 넣는다
        aria-label={[
          active
            ? t('activity.pill', {
                percent: `${progress.percent}%`,
                done: progress.done,
                total: progress.total
              })
            : t('activity.title'),
          failed > 0 ? `${t('job.failed')}: ${failed}` : null
        ]
          .filter(Boolean)
          .join(', ')}
        title={active ? t('activity.title') : t('activity.idle')}
        className={cn(
          'relative flex h-9 items-center gap-2 rounded-full border pl-1 pr-3 text-[12.5px] font-semibold transition-colors',
          open
            ? 'border-[var(--ac)] bg-[var(--acw)]'
            : 'border-[var(--bd)] bg-[var(--sf)] hover:bg-[var(--hv)]'
        )}
      >
        <span className="relative flex h-7 w-7 items-center justify-center">
          <Ring percent={progress.percent} active={active} />
          {opsRunning && !active ? (
            <Loader className="spin h-3.5 w-3.5 text-[var(--ac)]" aria-hidden />
          ) : (
            <Icon
              className={cn('h-3.5 w-3.5', active ? 'text-[var(--ac)]' : 'text-[var(--mu)]')}
              strokeWidth={2.25}
              aria-hidden
            />
          )}
        </span>
        {active ? (
          <span className="mono text-[12px]">
            {progress.percent}%
            <span className="text-[var(--mu)]">
              {' · '}
              {progress.done}/{progress.total}
            </span>
          </span>
        ) : (
          <span className="text-[var(--mu)]">{t('activity.title')}</span>
        )}
        {failed > 0 && (
          <span
            data-tone="danger"
            aria-hidden
            className="mono flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--dg)] px-1 text-[10.5px] font-bold text-white"
          >
            {failed}
          </span>
        )}
      </button>
      {open && <ActivityPopover anchor={button} onClose={close} />}
    </>
  )
}
