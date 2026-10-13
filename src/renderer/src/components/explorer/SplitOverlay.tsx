import { useState } from 'react'
import { useT } from '@renderer/i18n'
import { SPLIT_FADE_MS, SPLIT_SWITCH_MS } from '@renderer/lib/explorerLayout'
import { locLabel } from '@renderer/lib/sendItems'
import { overlayRect, type Rect, type Zone } from '@renderer/lib/splitLayout'
import { useTabsStore, visiblePanes } from '@renderer/stores/useTabsStore'
import { SourceBadge } from '@renderer/components/common/SourceBadge'
import {
  dropActionFor,
  remainingFor,
  useTabDragStore
} from '@renderer/components/layout/useTabDrag'

/**
 * 탭 드래그 분할 오버레이(split-view F6·F7·P15). 분할 모드로 끄는 동안 한 번 무장된 뒤로는 마운트된 채
 * 무장 여부로 나타나고 흐려진다. 무장이 풀리면 마지막 존 자리에서 흐려지고, 다른 존에서 다시 무장되면
 * 같은 요소가 그 자리로 옮겨 가 좌↔우 전환이 위치 transition으로 움직인다(F7). 분할이 안 보이면 콘텐츠의
 * 그쪽 절반, 보이면 교체될 패널 영역을 칠한다(Q5). 가운데 칩은 출처 배지 + 할 일, 반대쪽 칩은 놓은 뒤
 * 그쪽에 남을 탭. 포인터를 받지 않고 보조 기술에 숨긴다.
 */
export function SplitOverlay(): React.JSX.Element | null {
  const t = useT()
  const id = useTabDragStore((s) => s.id)
  const mode = useTabDragStore((s) => s.mode)
  const armed = useTabDragStore((s) => s.armed)
  const zone = useTabDragStore((s) => s.zone)
  const rect = useTabDragStore((s) => s.rect)
  const tabs = useTabsStore((s) => s.tabs)
  const activeId = useTabsStore((s) => s.activeId)
  const split = useTabsStore((s) => s.split)
  const state = { tabs, activeId, split }
  const tab = tabs.find((x) => x.id === id)

  // 지금 칠하는 존(무장됨)과 마지막으로 칠한 존. 드래그가 끝나면 잊는다.
  const live = tab && armed && (zone === 'left' || zone === 'right') ? zone : null
  const [last, setLast] = useState<Zone | null>(null)
  const keep = tab && mode === 'split' ? (live ?? last) : null
  if (keep !== last) setLast(keep)
  if (!tab || !rect || (keep !== 'left' && keep !== 'right')) return null
  const action = dropActionFor(state, tab.id, keep)
  if (!action) return null

  const shown = live !== null
  const ratio = visiblePanes(state).length === 2 && split ? split.ratio : null
  const target = overlayRect(rect, keep, ratio)
  const other = overlayRect(rect, keep === 'left' ? 'right' : 'left', ratio)
  // 콘텐츠 기준 가로 위치. 세로는 콘텐츠 전체다. 나타남·흐려짐은 opacity, 좌↔우는 위치 transition.
  const place = (r: Rect): React.CSSProperties => ({
    left: r.left - rect.left,
    width: r.width,
    opacity: shown ? 1 : 0,
    animation: `split-overlay-in ${SPLIT_FADE_MS}ms ease-out`,
    transition: [
      `opacity ${SPLIT_FADE_MS}ms ease-out`,
      `left ${SPLIT_SWITCH_MS}ms ease-out`,
      `width ${SPLIT_SWITCH_MS}ms ease-out`
    ].join(', ')
  })
  const name = locLabel(tab.loc)
  const label =
    action === 'swap'
      ? t('split.swap')
      : action === 'replace'
        ? t('split.replace', { name })
        : t(keep === 'left' ? 'split.splitLeft' : 'split.splitRight', { name })
  const remainingId = remainingFor(state, tab.id, keep)
  const remaining = tabs.find((x) => x.id === remainingId)
  const chip =
    'flex max-w-[80%] items-center gap-2 rounded-full border border-[var(--bd)] bg-[var(--sf)] py-1 pl-1.5 pr-3.5 text-[13px] font-semibold text-[var(--tx)] shadow-[var(--shadow)]'

  return (
    <div
      data-testid="split-overlay"
      aria-hidden
      className="pointer-events-none absolute inset-0 z-30"
    >
      <div
        data-zone={shown ? keep : undefined}
        className="split-overlay-zone absolute inset-y-0 p-[6px]"
        style={place(target)}
      >
        <div className="split-overlay-wash flex h-full w-full items-center justify-center rounded-[12px]">
          <span className={chip}>
            <SourceBadge side={tab.loc.side} size={22} />
            <span className="truncate">{label}</span>
          </span>
        </div>
      </div>
      {remaining && (
        <div
          className="split-overlay-zone absolute inset-y-0 flex items-center justify-center"
          style={place(other)}
        >
          <span className={`${chip} opacity-70`}>
            <span className="truncate pl-2">
              {t('split.remaining', { name: locLabel(remaining.loc) })}
            </span>
          </span>
        </div>
      )}
    </div>
  )
}
