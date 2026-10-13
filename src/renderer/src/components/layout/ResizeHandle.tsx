import { PANE_SPECS, type PaneSide } from '@renderer/lib/sidebarLayout'
import type { ResizableSidebar } from '@renderer/hooks/useResizableSidebar'
import { useT } from '@renderer/i18n'

interface ResizeHandleProps {
  side: PaneSide
  /** 조절하는 패널의 id (`aria-controls`) */
  controls: string
  state: Pick<ResizableSidebar, 'collapsed' | 'dragging' | 'valueNow' | 'handleProps'>
}

/**
 * 패널 경계의 끌기 영역(window splitter). 접히면 같은 요소가 창 가장자리로 옮겨 가
 * 끌어내기 영역이 된다. 요소를 바꿔 끼우면 드래그 도중 포인터 캡처를 잃는다(D6).
 */
export function ResizeHandle({ side, controls, state }: ResizeHandleProps): React.JSX.Element {
  const t = useT()
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t(side === 'left' ? 'panes.resizeLeft' : 'panes.resizeRight')}
      aria-controls={controls}
      aria-valuemin={0}
      aria-valuemax={PANE_SPECS[side].max}
      aria-valuenow={state.valueNow}
      aria-valuetext={
        state.collapsed ? t('panes.collapsed') : t('panes.widthValue', { width: state.valueNow })
      }
      tabIndex={0}
      className="pane-handle"
      data-side={side}
      data-collapsed={state.collapsed ? 'true' : undefined}
      data-dragging={state.dragging ? 'true' : undefined}
      {...state.handleProps}
    />
  )
}
