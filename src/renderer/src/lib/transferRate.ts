/**
 * 전송 속도·남은 시간·묶음 진행률. 속도는 `transfer:updated` 표본으로 렌더러가 계산한다(D18).
 */
import { t } from '@renderer/i18n'
import type { TransferJob } from '@shared/types/transfer'

/** 작업 하나의 마지막 표본과 지수 평활한 속도(B/s). 표본이 하나뿐이면 속도는 0이다. */
export interface RateSample {
  bytes: number
  at: number
  rate: number
  samples: number
}

const ALPHA = 0.3

export function nextRate(prev: RateSample | undefined, bytes: number, at: number): RateSample {
  if (!prev) return { bytes, at, rate: 0, samples: 1 }
  const dt = (at - prev.at) / 1000
  if (dt <= 0) return prev
  const instant = Math.max(0, bytes - prev.bytes) / dt
  const rate = prev.samples === 1 ? instant : ALPHA * instant + (1 - ALPHA) * prev.rate
  return { bytes, at, rate, samples: prev.samples + 1 }
}

/** 남은 초. 속도가 0이면 알 수 없다(null). */
export function remainingSeconds(remainingBytes: number, rate: number): number | null {
  return rate > 0 ? Math.max(0, remainingBytes) / rate : null
}

/** 진행 중인 퍼센트. 서버가 226으로 답해야 완료이므로 완료 전에는 100%를 보이지 않는다. */
export function livePercent(value: number): number {
  return Math.min(99, value)
}

function percent(part: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((part / total) * 100)))
}

export interface BatchProgress {
  percent: number
  done: number
  total: number
  transferredBytes: number
  totalBytes: number
}

/** 묶음 합계. 바이트가 없으면(0바이트 파일들) 완료한 파일 수로 잰다. 전부 완료 전에는 99% 상한. */
export function batchProgress(jobs: readonly TransferJob[]): BatchProgress {
  const totalBytes = jobs.reduce((sum, j) => sum + j.totalBytes, 0)
  const transferredBytes = jobs.reduce(
    (sum, j) =>
      sum +
      (j.status === 'completed'
        ? j.totalBytes
        : Math.min(j.totalBytes, Math.max(0, j.transferredBytes))),
    0
  )
  const done = jobs.filter((j) => j.status === 'completed').length
  const raw = totalBytes > 0 ? percent(transferredBytes, totalBytes) : percent(done, jobs.length)
  return {
    percent: done === jobs.length && jobs.length > 0 ? 100 : livePercent(raw),
    done,
    total: jobs.length,
    transferredBytes,
    totalBytes
  }
}

/** "45 s", "2 min", "2 h" — 가장 큰 단위 하나로 반올림한다. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return t('duration.seconds', { number: s })
  if (s < 3600) return t('duration.minutes', { number: Math.round(s / 60) })
  return t('duration.hours', { number: Math.round(s / 3600) })
}
