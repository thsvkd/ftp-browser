import { cn } from '@renderer/lib/utils'
import { useT } from '@renderer/i18n'
import { tierName } from '@renderer/lib/agentText'
import type { RiskTier } from '@shared/types/agent'

/** 위험 등급마다 한 색. 읽기는 회색, 손실 없는 변경은 파랑, 삭제는 빨강, 업로드는 주황, 서버 설정은 보라. */
const TIER_COLORS: Record<RiskTier, string> = {
  R: 'bg-gray-100 text-gray-700 ring-gray-300',
  W: 'bg-blue-50 text-blue-700 ring-blue-200',
  D: 'bg-red-50 text-red-700 ring-red-200',
  X: 'bg-amber-50 text-amber-800 ring-amber-200',
  C: 'bg-purple-50 text-purple-700 ring-purple-200'
}

/** 등급 글자와 번역된 등급 이름(handoff agent-operations §2.2). */
export function TierBadge({ tier }: { tier: RiskTier }): React.JSX.Element {
  const t = useT()
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset',
        TIER_COLORS[tier]
      )}
    >
      <span className="font-bold">{tier}</span>
      <span className="font-medium">{tierName(t, tier)}</span>
    </span>
  )
}
