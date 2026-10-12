/** 활동 팝오버와 전송 패널이 함께 쓰는 작은 UI 조각. */
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  CircleAlert,
  CircleCheck,
  CircleSlash
} from 'lucide-react'
import { useT } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'
import type { TransferJob } from '@shared/types/transfer'
import { batchIconState } from './activityJobs'

export const ICON_BTN =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]'
export const TEXT_BTN =
  'inline-flex h-7 items-center gap-1.5 rounded-[10px] px-2 text-[12px] font-semibold text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]'

export function ProgressBar({
  label,
  value,
  tone = 'bg-[var(--ac)]'
}: {
  label: string
  value: number
  tone?: string
}): React.JSX.Element {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className="h-1.5 overflow-hidden rounded-full bg-[var(--bd)]"
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-200', tone)}
        style={{ width: `${value}%` }}
      />
    </div>
  )
}

/**
 * 묶음의 상태 그림(장식). 도는 중이면 방향, 끝났으면 완료·실패·취소. 상태 글자는 부르는 쪽이 따로 둔다.
 * 도는 서버 간 복사 묶음만 그림이 그 종류를 말한다(이름표는 다른 묶음과 같은 규칙, MC32).
 */
export function BatchIcon({
  jobs,
  className = 'h-4 w-4'
}: {
  jobs: readonly TransferJob[]
  className?: string
}): React.JSX.Element {
  const t = useT()
  const state = batchIconState(jobs)
  const direction = jobs[0]?.direction
  const relay = state === 'running' && direction === 'relay'
  const Icon =
    state === 'completed'
      ? CircleCheck
      : state === 'failed'
        ? CircleAlert
        : state === 'cancelled'
          ? CircleSlash
          : relay
            ? ArrowLeftRight
            : direction === 'upload'
              ? ArrowUpFromLine
              : ArrowDownToLine
  const tone = {
    running: 'text-[var(--ac)]',
    completed: 'text-[var(--ok)]',
    failed: 'text-[var(--dg)]',
    cancelled: 'text-[var(--mu)]'
  }[state]
  const icon = <Icon data-status={state} className={cn('shrink-0', tone, className)} aria-hidden />
  return relay ? (
    <span role="img" aria-label={t('activity.relay')} title={t('activity.relay')} className="flex">
      {icon}
    </span>
  ) : (
    icon
  )
}
