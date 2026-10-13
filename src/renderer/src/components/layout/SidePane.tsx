import { useLayoutEffect, useRef } from 'react'
import { useResizableSidebar } from '@renderer/hooks/useResizableSidebar'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import type { PaneSide } from '@renderer/lib/sidebarLayout'
import { ResizeHandle } from './ResizeHandle'

interface SidePaneProps {
  side: PaneSide
  id: string
  /** 본문 행의 폭. 모르면(null·0) 좁은 창 맞춤을 하지 않는다 */
  containerWidth: number | null
  children: React.ReactNode
}

/**
 * 끌어서 폭을 바꾸고 접을 수 있는 사이드 패널. 접혀도 내용은 언마운트하지 않고
 * `inert`로 접근성 트리와 탭 순서에서만 뺀다(D8).
 */
export function SidePane({ side, id, containerWidth, children }: SidePaneProps): React.JSX.Element {
  const r = useResizableSidebar(side, containerWidth)
  const paneRef = useRef<HTMLDivElement>(null)

  // 접히는 순간 포커스가 패널 안에 있었으면 본문 목록으로 옮긴다. 크롬의 inert 보정은 비동기다.
  // 분할 보기에서는 활성 패널의 목록이다(없으면 첫 목록). 아니면 접기만으로 활성 패널이 바뀐다.
  useLayoutEffect(() => {
    const pane = paneRef.current
    if (!r.collapsed || !pane?.contains(document.activeElement)) return
    ;(
      document.getElementById(`explorer-list-${useTabsStore.getState().activeId}`) ??
      document.querySelector<HTMLElement>('[id^="explorer-list-"]')
    )?.focus()
  }, [r.collapsed])

  return (
    <div className="relative flex shrink-0">
      <div
        ref={paneRef}
        id={id}
        className="side-pane h-full"
        style={{ width: r.width }}
        data-side={side}
        data-collapsed={r.collapsed ? 'true' : undefined}
        data-dragging={r.dragging ? 'true' : undefined}
        data-animate={r.animate ? 'true' : undefined}
        inert={r.collapsed}
        aria-hidden={r.collapsed ? true : undefined}
        onTransitionEnd={r.onTransitionEnd}
      >
        <div className="flex h-full shrink-0" style={{ width: r.contentWidth }}>
          {children}
        </div>
      </div>
      <ResizeHandle side={side} controls={id} state={r} />
    </div>
  )
}
