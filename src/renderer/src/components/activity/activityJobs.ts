/** 활동 알약·팝오버가 함께 쓰는 전송 묶음 계산(순수 함수). */
import { batchProgress, remainingSeconds, type RateSample } from '@renderer/lib/transferRate'
import type { Loc } from '@renderer/lib/explorerEntry'
import { fallbackBatchMeta, type BatchMeta } from '@renderer/stores/useTransferStore'
import type { TransferJob, TransferStatus } from '@shared/types/transfer'

export const isLive = (j: TransferJob): boolean => j.status === 'pending' || j.status === 'active'

/**
 * 배치 하나(배치 id가 없는 작업은 혼자 한 묶음). 새것이 위로 온다. 메타가 없는 배치의 메타는 스토어가
 * 처음 볼 때 정해 둔다(`applyUpdate`).
 */
export interface JobGroup {
  key: string
  label: string
  to: Loc
  jobs: TransferJob[]
}

export function groupJobs(
  jobs: readonly TransferJob[],
  batchMeta: Record<string, BatchMeta>
): JobGroup[] {
  const byKey = new Map<string, TransferJob[]>()
  for (const job of jobs) {
    const key = job.batchId ?? `job:${job.id}`
    const list = byKey.get(key)
    if (list) list.push(job)
    else byKey.set(key, [job])
  }
  return [...byKey]
    .map(([key, list]) => ({
      key,
      jobs: list,
      ...(batchMeta[key] ?? fallbackBatchMeta(list))
    }))
    .reverse()
}

/** 작업들의 합계 속도(B/s)와 남은 시간. 속도를 모르면 남은 시간은 null. */
export function speedOf(
  jobs: readonly TransferJob[],
  rates: Record<string, RateSample>
): { speed: number; eta: number | null } {
  const speed = jobs.reduce((s, j) => s + (j.status === 'active' ? (rates[j.id]?.rate ?? 0) : 0), 0)
  const p = batchProgress(jobs.filter(isLive))
  return { speed, eta: remainingSeconds(p.totalBytes - p.transferredBytes, speed) }
}

/** 지금 도는 묶음들(대기·진행 중인 작업이 하나라도 있는 배치)의 작업. 알약과 팝오버 머리가 쓴다. */
export function runningJobs(jobs: readonly TransferJob[]): TransferJob[] {
  const live = new Set(jobs.filter(isLive).map((j) => j.batchId ?? j.id))
  return jobs.filter((j) => live.has(j.batchId ?? j.id))
}

export function groupStatus(jobs: readonly TransferJob[]): TransferStatus {
  for (const s of ['active', 'pending', 'failed', 'cancelled'] as const)
    if (jobs.some((j) => j.status === s)) return s
  return 'completed'
}

/** 대기 중인 파일이 없고 진행 중인 파일이 모두 바이트를 다 넘겼다: 서버의 226만 기다린다. */
export function isFinishing(jobs: readonly TransferJob[]): boolean {
  return (
    groupStatus(jobs) === 'active' &&
    jobs.every(
      (j) => j.status !== 'pending' && (j.status !== 'active' || j.transferredBytes >= j.totalBytes)
    )
  )
}

/** 목적지 바로 아래의 항목 이름. 폴더를 받았으면 그 폴더, 파일이면 그 파일. */
export function topItemName(job: TransferJob, to: Loc): string | undefined {
  const path = to.side === 'local' ? job.localPath : job.remotePath
  const seps = to.side === 'local' ? ['\\', '/'] : ['/']
  const prefix = seps.some((s) => to.path.endsWith(s))
    ? to.path
    : seps.map((s) => to.path + s).find((p) => path.startsWith(p))
  if (!prefix || !path.startsWith(prefix)) return undefined
  return path.slice(prefix.length).split(to.side === 'local' ? /[\\/]/ : '/')[0] || undefined
}
