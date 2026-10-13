import { useT } from '@renderer/i18n'
import type { ExplorerEntry } from '@renderer/lib/explorerEntry'
import { batchProgress } from '@renderer/lib/transferRate'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import type { TransferJob } from '@shared/types/transfer'

const LIVE = new Set<TransferJob['status']>(['pending', 'active', 'failed'])

/**
 * 이 항목이 출처인 진행 중 전송의 상태 요약 `"상태:퍼센트"`. 폴더는 그 아래 작업을 합친다. 원격
 * 항목은 경로와 서버가 모두 맞는 다운로드와, 보내는 쪽이 그 서버·경로인 서버 간 복사만 센다(MC32: 다른
 * 서버의 같은 경로는 다른 파일이고, 받는 쪽에는 고리를 그리지 않는다).
 * 문자열을 구독하므로 진행률이 실제로 바뀔 때만 다시 그린다.
 */
function summary(
  jobs: readonly TransferJob[],
  entry: Pick<ExplorerEntry, 'side' | 'path' | 'server'>
): string {
  const seps = entry.side === 'local' ? ['\\', '/'] : ['/']
  const mine = jobs.filter((j) => {
    if (!LIVE.has(j.status)) return false
    const src =
      entry.side === 'local'
        ? j.direction === 'upload' && j.localPath
        : j.direction === 'download'
          ? j.server === entry.server && j.remotePath
          : j.direction === 'relay' && j.sourceServer === entry.server && j.sourcePath
    return !!src && (src === entry.path || seps.some((s) => src.startsWith(entry.path + s)))
  })
  if (!mine.length) return ''
  const state = mine.some((j) => j.status === 'failed')
    ? 'failed'
    : mine.some((j) => j.status === 'active')
      ? 'active'
      : 'pending'
  return `${state}:${batchProgress(mine).percent}`
}

/** 타일 모서리의 진행 고리. 실패가 섞이면 위험 색 "!", 대기 중이면 흐린 점. */
export function TransferRing({
  entry,
  size = 26
}: {
  entry: Pick<ExplorerEntry, 'side' | 'path' | 'server'>
  size?: number
}): React.JSX.Element | null {
  const t = useT()
  const state = useTransferStore((s) => summary(s.jobs, entry))
  if (!state) return null
  const [status, pctText] = state.split(':')
  const pct = Number(pctText)
  const r = size / 2 - 3
  const c = 2 * Math.PI * r
  const failed = status === 'failed'
  const color = failed ? 'var(--dg)' : status === 'active' ? 'var(--ac)' : 'var(--mu)'
  return (
    <span
      role="img"
      aria-label={`${t(failed ? 'job.failed' : status === 'active' ? 'job.active' : 'job.pending')} ${pct}%`}
      data-transfer-ring={status}
      className="relative flex items-center justify-center rounded-full bg-[var(--sf)] shadow-md"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--bd)"
          strokeWidth={2.5}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={failed ? 0 : c * (1 - pct / 100)}
          style={{ transition: 'stroke-dashoffset .2s linear' }}
        />
      </svg>
      <span aria-hidden className="mono absolute text-[9px] font-bold" style={{ color }}>
        {failed ? '!' : status === 'active' ? pct : '·'}
      </span>
    </span>
  )
}
