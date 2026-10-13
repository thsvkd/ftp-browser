import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  clampPaneWidth,
  resetPane,
  sanitizePaneState,
  togglePane,
  type PaneSide,
  type PaneState
} from '@renderer/lib/sidebarLayout'

interface LayoutStore {
  left: PaneState
  right: PaneState
  /** 마지막으로 커밋한 쪽. 좁은 창 맞춤(D12)이 이쪽 폭을 먼저 지킨다. 저장하지 않는다. */
  priority: PaneSide | null

  commit: (side: PaneSide, patch: Partial<PaneState>) => void
  toggle: (side: PaneSide) => void
  reset: (side: PaneSide) => void
}

/** 사이드바 폭과 접힘(D11). `width`는 마지막으로 펼쳐져 있던 폭이라 접혀 있는 동안에도 남는다. */
export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set) => ({
      left: resetPane('left'),
      right: resetPane('right'),
      priority: null,

      commit: (side, patch) =>
        set((s) => ({
          [side]: {
            width: clampPaneWidth(side, patch.width ?? s[side].width),
            collapsed: patch.collapsed ?? s[side].collapsed
          },
          priority: side
        })),
      toggle: (side) => set((s) => ({ [side]: togglePane(s[side]), priority: side })),
      reset: (side) => set({ [side]: resetPane(side), priority: side })
    }),
    {
      name: 'ftp-browser-layout',
      version: 1,
      partialize: (s) => ({ left: s.left, right: s.right }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as { left?: unknown; right?: unknown }
        return {
          ...current,
          left: sanitizePaneState('left', p.left),
          right: sanitizePaneState('right', p.right)
        }
      }
    }
  )
)
