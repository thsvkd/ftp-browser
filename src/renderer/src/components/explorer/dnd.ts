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
import type { ExplorerEntry, Loc } from '@renderer/lib/explorerEntry'
import { planSend } from '@renderer/lib/sendPlan'
import { useConnectedKeys } from '@renderer/lib/connections'
import { dropOsFiles, planVerb, sendItems, shelveOsFiles } from '@renderer/lib/sendItems'
import { useShelfStore } from '@renderer/stores/useShelfStore'

interface DndState {
  items: ExplorerEntry[] | null
  /** 지금 커서 아래의 놓기 대상 키 */
  over: string | null
  /** 고스트에 겹쳐 보일 화면 속 썸네일(최대 3) */
  thumbs: string[]
}

export const useDnd = create<DndState>(() => ({ items: null, over: null, thumbs: [] }))

/** `DragGhost`가 그리는 요소의 id. `setDragImage`가 이 요소를 찍는다. */
export const GHOST_ID = 'explorer-drag-ghost'

export function endDrag(): void {
  useDnd.setState({ items: null, over: null, thumbs: [] })
}

export function startDrag(e: DragEvent, items: ExplorerEntry[]): void {
  const thumbs = items
    .slice(0, 3)
    .map(
      (it) =>
        document.querySelector(`[data-path="${CSS.escape(it.path)}"] img`)?.getAttribute('src') ??
        ''
    )
  // 고스트가 지금 그려져 있어야 setDragImage가 찍을 수 있다.
  flushSync(() => useDnd.setState({ items, over: null, thumbs }))
  // 스프링으로 탭이 바뀌면 끌기 시작한 타일이 언마운트되어 dragend가 React에 오지 않는다.
  // 끌기가 끝난 뒤(놓기·취소) 첫 마우스 이벤트에서 상태를 지운다(함정 6).
  const reset = (): void => {
    document.removeEventListener('mousemove', reset, true)
    document.removeEventListener('pointerdown', reset, true)
    endDrag()
  }
  setTimeout(() => {
    document.addEventListener('mousemove', reset, true)
    document.addEventListener('pointerdown', reset, true)
  })
  e.dataTransfer.effectAllowed = 'copyMove'
  e.dataTransfer.setData('text/plain', items.map((i) => i.path).join('\n'))
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
  const over = useDnd((s) => s.over === key)
  const connected = useConnectedKeys()
  const plan = items && dest && dest !== 'shelf' ? planSend(items, dest, connected) : null
  const valid = !!dest && (dest === 'shelf' ? !!items : !plan?.invalid)
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
    verb: dest === 'shelf' ? t('menu.addToShelf') : plan && !plan.invalid ? planVerb(plan) : '',
    reason: plan?.invalid ? t(plan.invalid) : null,
    handlers: {
      onDragOver: (e) => {
        if (!dest) return
        // 다른 쪽 전송과 다른 서버로의 복사(relay)는 복사 커서, 같은 쪽 원격은 이동
        const copies = plan?.transfer.length || plan?.relay.length || dest === 'shelf'
        if (useDnd.getState().items) enter(e, valid ? (copies ? 'copy' : 'move') : 'none')
        else if (hasFiles(e)) enter(e, 'copy')
      },
      onDrop: (e) => {
        if (!dest) return
        const dragged = useDnd.getState().items
        if (!dragged && !hasFiles(e)) return
        e.preventDefault()
        e.stopPropagation()
        endDrag()
        if (!dragged) {
          const files = Array.from(e.dataTransfer.files)
          void (dest === 'shelf' ? shelveOsFiles(files) : dropOsFiles(files, dest))
        } else if (dest === 'shelf') {
          if (!useShelfStore.getState().add(dragged)) toast(t('toast.alreadyOnShelf'))
        } else {
          void sendItems(dragged, dest)
        }
      }
    }
  }
}
