import { Laptop, Server } from 'lucide-react'
import type { Side } from '@renderer/lib/explorerEntry'

/** 출처 배지: 내 PC(노트북)·서버. 탭·경로 막대 루트·선반·사이드바가 같은 모양을 쓴다. */
export function SourceBadge({ side, size = 22 }: { side: Side; size?: number }): React.JSX.Element {
  const Icon = side === 'remote' ? Server : Laptop
  const color = side === 'remote' ? 'var(--ac)' : 'var(--local)'
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-[7px]"
      style={{
        width: size,
        height: size,
        color,
        background: `color-mix(in srgb, ${color} 16%, transparent)`
      }}
    >
      <Icon style={{ width: size * 0.62, height: size * 0.62 }} strokeWidth={2} />
    </span>
  )
}
