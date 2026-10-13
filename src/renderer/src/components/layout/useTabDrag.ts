import { useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { create } from 'zustand'
import { SPLIT_DWELL_MS, TAB_DRAG_START_PX } from '@renderer/lib/explorerLayout'
import { currentPlatform, isMac } from '@renderer/lib/platform'
import {
  dragModeFor,
  insertionIndex,
  splitPartner,
  zoneFromPoint,
  type Rect,
  type Zone
} from '@renderer/lib/splitLayout'
import {
  useTabsStore,
  visiblePanes,
  type PaneId,
  type TabsState
} from '@renderer/stores/useTabsStore'

/** 탭 드래그 상태(split-view §5). 탭줄(고스트·표시선)과 `SplitOverlay`가 읽는다. */
export interface TabDragState {
  /** 끄는 탭. null이면 드래그 중이 아니다(idle·pending) */
  id: string | null
  x: number
  y: number
  mode: 'reorder' | 'split'
  /** 분할 모드에서 포인터가 있는 존. 창 밖·콘텐츠 밖이면 null */
  zone: Zone | null
  /** 존에 `SPLIT_DWELL_MS` 머물렀고 놓으면 할 일이 있다(P15): 오버레이가 보인다 */
  armed: boolean
  /** 순서 변경의 삽입 위치(단위 인덱스)와 표시선 자리(뷰포트 px) */
  insert: { index: number; x: number; top: number; height: number } | null
  /** 콘텐츠(`[data-split-root]`) rect */
  rect: Rect | null
}

const IDLE: TabDragState = {
  id: null,
  x: 0,
  y: 0,
  mode: 'reorder',
  zone: null,
  armed: false,
  insert: null,
  rect: null
}

export const useTabDragStore = create<TabDragState>(() => IDLE)

/** 놓으면 무엇을 하는가(P15). 분할이 보이면 교체·좌우 바꾸기, 아니면 새 분할. 할 일이 없으면 null */
export type DropAction = 'split' | 'replace' | 'swap'
export function dropActionFor(s: TabsState, id: string, pane: PaneId): DropAction | null {
  if (s.tabs.length < 2) return null
  const panes = visiblePanes(s)
  if (panes.length < 2) return 'split'
  const here = panes.find((p) => p.pane === pane)?.tabId
  if (here === id) return null
  return panes.some((p) => p.tabId === id) ? 'swap' : 'replace'
}

/** 놓은 뒤 반대쪽 패널에 있을 탭(오버레이의 "남는 탭" 칩). */
export function remainingFor(s: TabsState, id: string, pane: PaneId): string | null {
  const panes = visiblePanes(s)
  if (panes.length < 2)
    return splitPartner(
      s.tabs.map((t) => t.id),
      s.activeId,
      id
    )
  const action = dropActionFor(s, id, pane)
  // 좌우 바꾸기면 지금 그 패널의 탭이 반대쪽으로 간다. 교체면 반대쪽 패널은 그대로다.
  return panes.find((p) => (action === 'swap' ? p.pane === pane : p.pane !== pane))?.tabId ?? null
}

/** 탭을 패널에 놓고(§3.2) 그 패널의 목록에 포커스를 준다(P3). */
export function placeAndFocus(id: string, pane: PaneId): void {
  flushSync(() => useTabsStore.getState().placeInPane(id, pane))
  document.getElementById(`explorer-list-${id}`)?.focus({ preventScroll: true })
}

const toRect = (r: DOMRect): Rect => ({
  left: r.left,
  top: r.top,
  width: r.width,
  height: r.height
})

/**
 * 탭 드래그(pointer events, F4·P16). 탭 버튼의 pointerdown에서 시작해 이후는 `window`에서 듣는다.
 * 4px 움직이면 드래그: 탭줄 근처는 순서 변경, 탭줄 하단 + 16px 아래는 분할 모드(히스테리시스).
 * 단위(일반 탭·묶음 알약)는 `stripRef` 안의 `[data-tab-unit]`(값 = 단위 첫 탭 id)이다.
 * 드래그로 끝난 pointerup 뒤의 click은 `consumeClick()`이 한 번 참을 돌려 무시하게 한다.
 */
export function useTabDrag(stripRef: React.RefObject<HTMLElement | null>): {
  onPointerDown: (e: React.PointerEvent<HTMLElement>, id: string) => void
  consumeClick: () => boolean
} {
  const suppress = useRef(false)
  const stop = useRef<(() => void) | null>(null)
  // 취소한 드래그 뒤의 click 무시를 푸는 일회성 리스너(`suppressAfterCancel`)
  const unarm = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      stop.current?.()
      unarm.current?.()
    },
    []
  )

  /** 다음 click 하나를 무시한다. click은 pointerup과 같은 태스크에 오므로 다음 태스크에 푼다(함정 10). */
  const suppressNextClick = (): void => {
    suppress.current = true
    setTimeout(() => {
      suppress.current = false
    }, 0)
  }

  /**
   * Esc·blur로 취소해도 버튼은 아직 눌려 있고 탭 버튼이 포인터를 캡처하고 있어, 손을 떼면 그 버튼에
   * click이 온다. 그 click도 활성 탭을 바꾸지 않게(§5 "변경 없음") 다음 pointerup까지 무시를 켜 둔다.
   * 그 전에 키를 누르면 바로 푼다(키보드 click은 막지 않는다).
   */
  const suppressAfterCancel = (): void => {
    unarm.current?.()
    suppress.current = true
    const release = (): void => {
      unarm.current?.()
      suppressNextClick()
    }
    const onKey = (): void => {
      unarm.current?.()
      suppress.current = false
    }
    window.addEventListener('pointerup', release, true)
    window.addEventListener('keydown', onKey, true)
    unarm.current = () => {
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('keydown', onKey, true)
      unarm.current = null
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLElement>, id: string): void => {
    unarm.current?.()
    suppress.current = false
    // 주 버튼만. macOS의 Ctrl+클릭은 우클릭 대용이다.
    if (e.button !== 0 || (e.ctrlKey && isMac(currentPlatform()))) return
    stop.current?.()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const start = { x: e.clientX, y: e.clientY }
    const set = useTabDragStore.setState
    let dragging = false
    let mode: 'reorder' | 'split' = 'reorder'
    let zone: Zone | null = null
    let stripBottom = 0
    let units: Array<{ id: string; rect: DOMRect }> = []
    let timer: ReturnType<typeof setTimeout> | undefined

    const disarm = (): void => {
      clearTimeout(timer)
      timer = undefined
    }
    const end = (): void => {
      disarm()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', cancel)
      stop.current = null
      if (dragging) set(IDLE)
    }
    // Esc·blur: 즉시 idle. 드래그 중이었으면 손을 뗄 때 오는 click도 무시한다.
    const cancel = (): void => {
      const wasDragging = dragging
      end()
      if (wasDragging) suppressAfterCancel()
    }

    const reorderAt = (x: number): TabDragState['insert'] => {
      if (!units.length) return null
      const index = insertionIndex(
        units.map((u) => u.rect.left + u.rect.width / 2),
        x
      )
      const last = units[units.length - 1].rect
      // 단위 사이 4px 틈 가운데에 2px 선
      const lineX = index < units.length ? units[index].rect.left - 3 : last.right + 1
      return { index, x: lineX, top: last.top, height: last.height }
    }

    const onMove = (ev: PointerEvent): void => {
      const { clientX: x, clientY: y } = ev
      if (!dragging) {
        if (Math.hypot(x - start.x, y - start.y) < TAB_DRAG_START_PX) return
        dragging = true
        const strip = stripRef.current
        stripBottom = strip?.getBoundingClientRect().bottom ?? 0
        units = Array.from(strip?.querySelectorAll<HTMLElement>('[data-tab-unit]') ?? []).map(
          (el) => ({ id: el.dataset.tabUnit ?? '', rect: el.getBoundingClientRect() })
        )
      }
      mode = dragModeFor(mode, y, stripBottom)
      // 창 밖에서 놓으면 아무 일도 없다(F9): 순서 변경은 표시선을 지우고, 분할은 존을 잡지 않는다.
      const outside = x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight
      if (mode === 'reorder') {
        disarm()
        zone = null
        const insert = outside ? null : reorderAt(x)
        set({ id, x, y, mode, zone, armed: false, insert, rect: null })
        return
      }
      const root = document.querySelector('[data-split-root]')
      const rect = root ? toRect(root.getBoundingClientRect()) : null
      // 탭이 하나면 분할할 수 없다(F3): 존을 잡지 않아 오버레이가 뜨지 않는다.
      const next =
        rect && !outside && useTabsStore.getState().tabs.length >= 2
          ? zoneFromPoint(rect, x, y)
          : null
      const changed = next !== zone
      if (changed) {
        // 존이 바뀌면 무장을 풀고 그 존에서 다시 기다린다.
        disarm()
        zone = next
        if (next === 'left' || next === 'right') {
          const pane = next
          timer = setTimeout(() => {
            if (dropActionFor(useTabsStore.getState(), id, pane)) set({ armed: true })
          }, SPLIT_DWELL_MS)
        }
      }
      set({
        id,
        x,
        y,
        mode,
        zone,
        rect,
        insert: null,
        armed: changed ? false : useTabDragStore.getState().armed
      })
    }

    const onUp = (): void => {
      const s = useTabDragStore.getState()
      const wasDragging = dragging
      end()
      if (!wasDragging) return
      // 같은 버튼에 오는 click은 활성 탭을 바꾸지 않는다(함정 10). 오지 않았으면(다른 곳에서 놓음)
      // 다음 태스크에 풀어 키보드 click을 막지 않는다.
      suppressNextClick()
      if (s.mode === 'reorder') {
        if (s.insert) useTabsStore.getState().moveTab(id, units[s.insert.index]?.id ?? null)
      } else if (s.armed && (s.zone === 'left' || s.zone === 'right')) {
        placeAndFocus(id, s.zone)
      }
    }

    const onKey = (ev: KeyboardEvent): void => {
      if (!dragging || ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      cancel()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', end)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', cancel)
    stop.current = end
  }

  const consumeClick = (): boolean => {
    const swallowed = suppress.current
    suppress.current = false
    return swallowed
  }

  return { onPointerDown, consumeClick }
}
