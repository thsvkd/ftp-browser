// 타일과 행이 함께 쓰는 항목 배선: 선택 이벤트, 끌기 출처, 폴더면 놓기 대상(+스프링).
import type { DragEvent, MouseEvent } from 'react'
import type { ExplorerEntry } from '@renderer/lib/explorerEntry'
import { optId, SPRING_MS } from '@renderer/lib/explorerLayout'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { endDrag, useDropTarget, type DropState } from './dnd'

export interface ItemProps {
  entry: ExplorerEntry
  selected: boolean
  /** 포커스 커서가 이 항목에 있다 */
  cursor: boolean
  /** 목록이 포커스를 가졌다(아니면 선택은 회색, 기준선 #7) */
  listFocused: boolean
  shelved: boolean
  renaming: boolean
  onSelect: (e: MouseEvent, entry: ExplorerEntry) => void
  onToggle: (entry: ExplorerEntry) => void
  onOpen: (entry: ExplorerEntry) => void
  onOpenTab: (entry: ExplorerEntry) => void
  onContext: (e: MouseEvent, entry: ExplorerEntry) => void
  onDragStart: (e: DragEvent, entry: ExplorerEntry) => void
  onRename: (entry: ExplorerEntry, name: string | null) => void
}

export interface ItemWiring {
  drop: DropState
  /** 폴더 위에 끄는 중이다 */
  dropOver: boolean
  attrs: {
    id: string
    role: 'option'
    'aria-selected': boolean
    'data-path': string
    'data-grid-cell': true
    draggable: boolean
    onClick: (e: MouseEvent) => void
    onAuxClick: (e: MouseEvent) => void
    onDoubleClick: () => void
    onContextMenu: (e: MouseEvent) => void
    onDragStart: (e: DragEvent) => void
    onDragEnd: () => void
    onDragOver: (e: DragEvent) => void
    onDrop: (e: DragEvent) => void
  }
}

export function useItem(p: ItemProps): ItemWiring {
  const { entry } = p
  const isDir = entry.type === 'directory'
  const loc = isDir ? { side: entry.side, path: entry.path, server: entry.server } : null
  const drop = useDropTarget(`dir:${entry.side}:${entry.path}`, loc, {
    spring: () => loc && useTabsStore.getState().navigate(loc),
    springMs: SPRING_MS
  })
  return {
    drop,
    dropOver: drop.over && isDir,
    attrs: {
      id: optId(entry.path),
      role: 'option',
      'aria-selected': p.selected,
      'data-path': entry.path,
      // 마퀴가 항목 위에서는 시작하지 않는다(useMarqueeSelection).
      'data-grid-cell': true,
      draggable: !p.renaming,
      onClick: (e) => p.onSelect(e, entry),
      onAuxClick: (e) => {
        if (e.button === 1 && isDir) p.onOpenTab(entry)
      },
      onDoubleClick: () => p.onOpen(entry),
      onContextMenu: (e) => p.onContext(e, entry),
      onDragStart: (e) => p.onDragStart(e, entry),
      onDragEnd: endDrag,
      onDragOver: drop.handlers.onDragOver,
      onDrop: drop.handlers.onDrop
    }
  }
}
