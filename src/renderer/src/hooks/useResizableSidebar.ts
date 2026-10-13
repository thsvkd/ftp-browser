import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HTMLAttributes } from 'react'
import { useLayoutStore } from '@renderer/stores/useLayoutStore'
import {
  PANE_ANIM_MS,
  applyPaneKey,
  dragMax,
  dragRaw,
  fitPaneWidths,
  paneKeyAction,
  resolveDrag,
  settleDrag,
  type PaneSide,
  type PaneState
} from '@renderer/lib/sidebarLayout'

export interface ResizableSidebar {
  /** 렌더 폭(맞춤 적용, 접힘 0) */
  width: number
  /** 안쪽 고정 폭. 접혀 있어도 기억 폭이고 맞춤 상한만 적용한다 */
  contentWidth: number
  collapsed: boolean
  dragging: boolean
  animate: boolean
  /** aria-valuenow (접힘 0) */
  valueNow: number
  handleProps: Pick<
    HTMLAttributes<HTMLDivElement>,
    | 'onPointerDown'
    | 'onPointerMove'
    | 'onPointerUp'
    | 'onPointerCancel'
    | 'onLostPointerCapture'
    | 'onKeyDown'
    | 'onDoubleClick'
  >
  onTransitionEnd: (e: React.TransitionEvent) => void
}

interface DragSnapshot {
  /** 드래그 시작 때 화면에 그려진 상태(맞춤 적용값) */
  rendered: PaneState
  /** 드래그 시작 때의 저장된 상태 */
  stored: PaneState
  /** 반대쪽의 시작 때 화면 폭 */
  otherWidth: number
  x0: number
  collapsed: boolean
  live: { collapsed: boolean; width: number } | null
}

/**
 * 사이드바 하나의 폭·접힘·드래그·키 조작(D4–D16). 드래그 중에는 지역 상태만 바꾸고
 * 놓을 때 스토어에 한 번 커밋한다.
 */
export function useResizableSidebar(
  side: PaneSide,
  containerWidth: number | null
): ResizableSidebar {
  const other: PaneSide = side === 'left' ? 'right' : 'left'
  const own = useLayoutStore((s) => s[side])
  const otherState = useLayoutStore((s) => s[other])
  const priority = useLayoutStore((s) => s.priority)
  const commit = useLayoutStore((s) => s.commit)
  const reset = useLayoutStore((s) => s.reset)
  const toggle = useLayoutStore((s) => s.toggle)

  const [live, setLive] = useState<{ collapsed: boolean; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [animate, setAnimate] = useState(false)
  const drag = useRef<DragSnapshot | null>(null)
  const skipAnimate = useRef(false)

  // 이 쪽 상태를 바꿔 가며 맞춤(D12)을 계산한다.
  const fit = (state: PaneState): { left: number; right: number } =>
    side === 'left'
      ? fitPaneWidths(containerWidth, state, otherState, priority)
      : fitPaneWidths(containerWidth, otherState, state, priority)
  const fitted = fit(own)
  const storedFit = fitted[side]
  const otherFitted = fitted[other]
  const expandedFit = fit({ ...own, collapsed: false })[side]

  const collapsed = live ? live.collapsed : own.collapsed
  const width = live ? live.width : storedFit
  const contentWidth = live && !live.collapsed ? live.width : expandedFit

  // 접힘이 바뀌는 커밋만 전환한다. 드래그 놓기 커밋은 settle 직전에 표시해 건너뛴다(D5).
  // 구독 콜백에서 켜므로 폭이 바뀌는 렌더와 같은 커밋에 data-animate가 실린다.
  useLayoutEffect(
    () =>
      useLayoutStore.subscribe((state, prev) => {
        if (state[side].collapsed === prev[side].collapsed) return
        if (skipAnimate.current) skipAnimate.current = false
        else setAnimate(true)
      }),
    [side]
  )

  // transitionend가 오지 않는 환경을 위한 보험
  useEffect(() => {
    if (!animate) return
    const timer = setTimeout(() => setAnimate(false), PANE_ANIM_MS + 50)
    return () => clearTimeout(timer)
  }, [animate])

  const finish = useCallback(
    (save: boolean): void => {
      const d = drag.current
      if (!d) return
      drag.current = null
      setDragging(false)
      setLive(null)
      if (!save || !d.live) return
      const next = settleDrag(d.stored, d.live)
      skipAnimate.current = next.collapsed !== useLayoutStore.getState()[side].collapsed
      commit(side, next)
    },
    [commit, side]
  )

  // 드래그 중 Esc는 시작 상태로 되돌리고 커밋하지 않는다(D14).
  useEffect(() => {
    if (!dragging) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dragging, finish])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.focus()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = {
      rendered: { width: storedFit, collapsed: own.collapsed },
      stored: own,
      otherWidth: otherFitted,
      x0: e.clientX,
      collapsed: own.collapsed,
      live: null
    }
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    const raw = dragRaw(side, d.rendered, d.x0, e.clientX)
    const next = resolveDrag(side, raw, d.collapsed, dragMax(side, containerWidth, d.otherWidth))
    d.collapsed = next.collapsed
    d.live = next
    setLive(next)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const action = paneKeyAction(side, e.key, e.shiftKey)
    if (!action) return
    e.preventDefault()
    e.stopPropagation()
    // Enter는 기억 폭을 건드리지 않고 접힘만 뒤집는다(D11·D12). 맞춤 폭을 저장하지 않도록 스토어 토글을 쓴다.
    if (action.kind === 'toggle') {
      toggle(side)
      return
    }
    const base = own.collapsed ? own : { width: storedFit, collapsed: false }
    commit(side, applyPaneKey(side, base, action, dragMax(side, containerWidth, otherFitted)))
  }

  return {
    width,
    contentWidth,
    collapsed,
    dragging,
    animate,
    valueNow: collapsed ? 0 : width,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: () => finish(true),
      onPointerCancel: () => finish(true),
      onLostPointerCapture: () => finish(true),
      onKeyDown,
      onDoubleClick: () => reset(side)
    },
    onTransitionEnd: (e) => {
      if (e.propertyName === 'width' && e.target === e.currentTarget) setAnimate(false)
    }
  }
}
