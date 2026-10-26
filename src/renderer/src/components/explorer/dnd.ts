/**
 * 앱 안 끌어 놓기. HTML5 DnD는 문자열만 나르므로 끄는 항목은 여기(`useDnd`)에 둔다.
 * 한 번에 놓기 대상 하나만 `over`다: 대상이 dragover에서 stopPropagation하고, 루트(AppShell)가
 * "아무 대상 위도 아님"으로 `over`를 지운다. OS 파일 드롭은 `items`가 없고 `Files`가 있다(함정 7).
 */
import { useEffect, useRef, type DragEvent } from 'react'
import { flushSync } from 'react-dom'
import { create } from 'zustand'
import { toast } from 'sonner'
import { t } from '@renderer/i18n'
import { locKey, type ExplorerEntry, type Loc } from '@renderer/lib/explorerEntry'
import { planSend } from '@renderer/lib/sendPlan'
import { connStatus, useConnectedKeys } from '@renderer/lib/connections'
import { dropOsFiles, planVerb, sendItemsStarted, shelveOsFiles } from '@renderer/lib/sendItems'
import { connectIntoPane, connectNow, startShelfConnect } from '@renderer/lib/splitConnect'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import type { FtpServer } from '@shared/types/ftp'

interface DndState {
  items: ExplorerEntry[] | null
  /**
   * 지금 끌는 저장 서버(M14). `items`(항목 드래그)와 한 번에 하나만 채워진다 —
   * 둘이 섞이면 놓기 대상의 판정이 갈린다.
   */
  server: FtpServer | null
  /** 지금 커서 아래의 놓기 대상 키 */
  over: string | null
  /** 고스트에 겹쳐 보일 화면 속 썸네일(최대 3) */
  thumbs: string[]
  /** 선반에서 끌어 온 드래그인지(F7): 전송 시작에 성공하면 그 항목을 선반에서 뺀다 */
  fromShelf: boolean
}

export const useDnd = create<DndState>(() => ({
  items: null,
  server: null,
  over: null,
  thumbs: [],
  fromShelf: false
}))

/** `DragGhost`가 그리는 요소의 id. `setDragImage`가 이 요소를 찍는다. */
export const GHOST_ID = 'explorer-drag-ghost'

export function endDrag(): void {
  useDnd.setState({ items: null, server: null, over: null, thumbs: [], fromShelf: false })
}

/**
 * 끌기가 끝난 뒤(놓기·취소) 첫 마우스 이벤트에서 상태를 지운다(함정 6).
 * 스프링으로 탭이 바뀌면 끌기 시작한 타일이 언마운트되어 dragend가 React에 오지 않는다.
 */
function armDragReset(): void {
  const reset = (): void => {
    document.removeEventListener('mousemove', reset, true)
    document.removeEventListener('pointerdown', reset, true)
    endDrag()
  }
  setTimeout(() => {
    document.addEventListener('mousemove', reset, true)
    document.addEventListener('pointerdown', reset, true)
  })
}

export function startDrag(e: DragEvent, items: ExplorerEntry[], fromShelf = false): void {
  // 같은 폴더를 연 다른 패널이 아니라 끌기 시작한 패널에서 썸네일을 찾는다(split-view P9).
  const root =
    (e.currentTarget instanceof Element && e.currentTarget.closest('[data-tab-pane]')) || document
  const thumbs = items
    .slice(0, 3)
    .map(
      (it) =>
        root.querySelector(`[data-path="${CSS.escape(it.path)}"] img`)?.getAttribute('src') ?? ''
    )
  // 고스트가 지금 그려져 있어야 setDragImage가 찍을 수 있다.
  flushSync(() => useDnd.setState({ items, server: null, over: null, thumbs, fromShelf }))
  armDragReset()
  e.dataTransfer.effectAllowed = 'copyMove'
  e.dataTransfer.setData('text/plain', items.map((i) => i.path).join('\n'))
  const ghost = document.getElementById(GHOST_ID)
  if (ghost) e.dataTransfer.setDragImage(ghost, 22, 22)
}

/** M14: 사이드바의 저장 서버 행을 끈다 — `items` 대신 `server`에 담긴다(항목 드래그와 구분). */
export function startServerDrag(e: DragEvent, server: FtpServer): void {
  // 고스트가 지금 그려져 있어야 setDragImage가 찍을 수 있다.
  flushSync(() =>
    useDnd.setState({ server, items: null, over: null, thumbs: [], fromShelf: false })
  )
  armDragReset()
  e.dataTransfer.effectAllowed = 'copyMove'
  e.dataTransfer.setData(
    'text/plain',
    `${server.username || 'anonymous'}@${server.host}:${server.port}`
  )
  const ghost = document.getElementById(GHOST_ID)
  if (ghost) e.dataTransfer.setDragImage(ghost, 22, 22)
}

export interface DropState {
  over: boolean
  valid: boolean
  /** "Download 3 · Move 1" — 여기 놓으면 일어날 일 */
  verb: string
  /** 막힌 사유(번역된 문장) */
  reason: string | null
  handlers: {
    onDragOver: (e: DragEvent) => void
    onDrop: (e: DragEvent) => void
  }
}

const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')

/**
 * 위치(전송·이동·복사) 또는 선반(`'shelf'`)인 놓기 대상. `dest`가 null이면 받지 않는다.
 * `spring`은 `springMs` 동안 머무르면 한 번 불린다(유효 여부와 상관없이).
 */
export function useDropTarget(
  key: string,
  dest: Loc | 'shelf' | null,
  opts: { spring?: () => void; springMs?: number } = {}
): DropState {
  const items = useDnd((s) => s.items)
  const fromShelf = useDnd((s) => s.fromShelf)
  const over = useDnd((s) => s.over === key)
  const connected = useConnectedKeys()
  const plan = items && dest && dest !== 'shelf' ? planSend(items, dest, connected) : null
  // M19: 선반에서 미연결 서버의 탭으로는 전송이 아니라 연결을 시작하므로 놓기로 인정한다(함정 K).
  const shelfConnect =
    !!items &&
    fromShelf &&
    !!dest &&
    dest !== 'shelf' &&
    dest.side === 'remote' &&
    !!dest.server &&
    connStatus(dest.server) !== 'connected'
  const valid = !!dest && (dest === 'shelf' ? !!items : shelfConnect || !plan?.invalid)
  const springRef = useRef(opts.spring)
  useEffect(() => {
    springRef.current = opts.spring
  })
  const springMs = opts.springMs ?? 0

  useEffect(() => {
    if (!over || !springMs) return
    const timer = setTimeout(() => springRef.current?.(), springMs)
    return () => clearTimeout(timer)
  }, [over, springMs])

  const enter = (e: DragEvent, effect: 'copy' | 'move' | 'none'): void => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = effect
    if (useDnd.getState().over !== key) useDnd.setState({ over: key })
  }

  return {
    over,
    valid,
    verb:
      dest === 'shelf'
        ? t('menu.addToShelf')
        : shelfConnect && dest
          ? t('explorer.connectTo', { server: dest.server ?? '' })
          : plan && !plan.invalid
            ? planVerb(plan)
            : '',
    reason: plan?.invalid ? t(plan.invalid) : null,
    handlers: {
      onDragOver: (e) => {
        if (!dest) return
        // 다른 쪽 전송과 다른 서버로의 복사(relay)는 복사 커서, 같은 쪽 원격은 이동
        const copies = plan?.transfer.length || plan?.relay.length || dest === 'shelf'
        if (useDnd.getState().items) enter(e, valid ? (copies ? 'copy' : 'move') : 'none')
        else if (useDnd.getState().server) {
          // M15: 서버는 분할 자리(콘텐츠 영역의 절반)가 아닌 곳에 놓으면 하이라이트 없이만 받는다 —
          // 놓으면 기존대로 연결만 된다(connectNow). 하이라이트는 분할 자리가 그린다.
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        } else if (hasFiles(e)) enter(e, 'copy')
      },
      onDrop: (e) => {
        if (!dest) return
        const state = useDnd.getState()
        const dragged = state.items
        // endDrag()가 fromShelf·server를 지우기 전에 붙잡아 둔다(F7·M14).
        const fromShelf = state.fromShelf
        const server = state.server
        if (!dragged && !server && !hasFiles(e)) return
        e.preventDefault()
        e.stopPropagation()
        endDrag()
        if (server) {
          // M15: 분할 자리가 아니면 기존대로 — 그냥 연결만 한다(패널·모달 없음).
          if (dest !== 'shelf') connectNow(server)
          return
        }
        if (!dragged) {
          const files = Array.from(e.dataTransfer.files)
          void (dest === 'shelf' ? shelveOsFiles(files) : dropOsFiles(files, dest))
          return
        }
        if (dest === 'shelf') {
          if (!useShelfStore.getState().add(dragged)) toast(t('toast.alreadyOnShelf'))
          return
        }
        // M19: 선반에서 미연결 서버의 탭으로 — 전송하지 않고 연결(분할 + 시도)부터 시작한다.
        // 목적 폴더를 못 보는 상태에서 보내는 것은 불가능하므로 2단계는 여기서만 존재한다.
        if (
          fromShelf &&
          dest.side === 'remote' &&
          dest.server !== undefined &&
          connStatus(dest.server) !== 'connected'
        ) {
          startShelfConnect(dest)
          return
        }
        // 선반에서 끌어 온 전송은 시작에 성공한 부분의 항목을, 모두 시작하면 이미 그 폴더에 있던
        // 항목까지 선반에서 뺀다(dropShelfOnce와 같다, F15).
        void sendItemsStarted(dragged, dest).then((started) => {
          if (fromShelf && started.length) useShelfStore.getState().remove(started.map(locKey))
        })
      }
    }
  }
}

/**
 * M15: 서버 드래그의 분할 놓기 대상 — 콘텐츠를 좌우 반으로 나눠 호버한 쪽만 예고한다.
 * 놓으면(onDrop) 바로 분할을 만든다 — 스프링이 아니라 놓기에서(함정 F). `over` 키는
 * 좌우가 따로라 호버한 쪽만 켜진다.
 */
export function useSplitDropTarget(
  key: string,
  side: 'left' | 'right'
): {
  over: boolean
  handlers: { onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void }
} {
  const over = useDnd((s) => s.over === key)
  return {
    over,
    handlers: {
      onDragOver: (e) => {
        if (!useDnd.getState().server) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
        if (useDnd.getState().over !== key) useDnd.setState({ over: key })
      },
      onDrop: (e) => {
        const server = useDnd.getState().server
        if (!server) return
        e.preventDefault()
        e.stopPropagation()
        endDrag()
        // ① 여기서 만든다(함정 F): 분할 → 자리표시자 탭 → 연결 시도(실패·타임아웃이면 복귀).
        connectIntoPane(server, side)
      }
    }
  }
}
