import { useT } from '@renderer/i18n'
import { SPLIT_FADE_MS, SPLIT_SWITCH_MS } from '@renderer/lib/explorerLayout'
import { locLabel } from '@renderer/lib/sendItems'
import { overlayRect, type Rect } from '@renderer/lib/splitLayout'
import { useTabsStore, visiblePanes } from '@renderer/stores/useTabsStore'
import { SourceBadge } from '@renderer/components/common/SourceBadge'
import {
  dropActionFor,
  remainingFor,
  useTabDragStore
} from '@renderer/components/layout/useTabDrag'

/**
 * 탭 드래그 분할 오버레이(split-view F6·F7·P15). 무장된 존이 있을 때만 그린다. 분할이 안 보이면 콘텐츠의
 * 그쪽 절반, 보이면 교체될 패널 영역을 칠한다(Q5). 가운데 칩은 출처 배지 + 할 일, 반대쪽 칩은 놓은 뒤
 * 그쪽에 남을 탭. 포인터를 받지 않고 보조 기술에 숨긴다.
 */
export function SplitOverlay(): React.JSX.Element | null {
  const t = useT()
  const id = useTabDragStore((s) => s.id)
  const armed = useTabDragStore((s) => s.armed)
  const zone = useTabDragStore((s) => s.zone)
  const rect = useTabDragStore((s) => s.rect)
  const tabs = useTabsStore((s) => s.tabs)
  const activeId = useTabsStore((s) => s.activeId)
  const split = useTabsStore((s) => s.split)
  const state = { tabs, activeId, split }
  const tab = tabs.find((x) => x.id === id)
  if (!tab || !armed || !rect || (zone !== 'left' && zone !== 'right')) return null
  const action = dropActionFor(state, tab.id, zone)
  if (!action) return null

  const ratio = visiblePanes(state).length === 2 && split ? split.ratio : null
  const target = overlayRect(rect, zone, ratio)
  const other = overlayRect(rect, zone === 'left' ? 'right' : 'left', ratio)
  // 콘텐츠 기준 가로 위치. 세로는 콘텐츠 전체다.
  const place = (r: Rect): React.CSSProperties => ({ left: r.left - rect.left, width: r.width })
  const name = locLabel(tab.loc)
  const label =
    action === 'swap'
      ? t('split.swap')
      : action === 'replace'
        ? t('split.replace', { name })
        : t(zone === 'left' ? 'split.splitLeft' : 'split.splitRight', { name })
  const remainingId = remainingFor(state, tab.id, zone)
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
        data-zone={zone}
        className="split-overlay-zone absolute inset-y-0 p-[6px]"
        style={{
          ...place(target),
          animation: `split-overlay-in ${SPLIT_FADE_MS}ms ease-out`,
          transition: `left ${SPLIT_SWITCH_MS}ms ease-out, width ${SPLIT_SWITCH_MS}ms ease-out`
        }}
      >
        <div className="split-overlay-wash flex h-full w-full items-center justify-center rounded-[12px]">
          <span className={chip}>
            <SourceBadge side={tab.loc.side} size={22} />
            <span className="truncate">{label}</span>
          </span>
        </div>
      </div>
      {remaining && (
        <div className="absolute inset-y-0 flex items-center justify-center" style={place(other)}>
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
