import { create } from 'zustand'

/**
 * 컨텍스트 메뉴 소유권 하나만 전역화한다(E1).
 *
 * 각 뷰는 `contextEntry`·`contextPos`를 지금처럼 로컬 state로 들고, 여기서는 "지금 메뉴를
 * 띄우고 있는 뷰가 누구인가"만 관리한다. 뷰들은 서로의 존재를 모른 채 이 값을 구독해
 * 소유권을 뺏기면 자기 메뉴를 닫는다. 그래야 패널을 가로질러도 메뉴가 언제나 하나만 남는다.
 */

/** 컨텍스트 메뉴를 띄울 수 있는 뷰의 식별자. 리터럴 흩뿌림을 막는다(E2). */
export const CONTEXT_MENU_OWNERS = {
  localList: 'local-list',
  localGrid: 'local-grid',
  remoteList: 'remote-list',
  remoteGrid: 'remote-grid'
} as const

export type ContextMenuOwner = (typeof CONTEXT_MENU_OWNERS)[keyof typeof CONTEXT_MENU_OWNERS]

interface ContextMenuStore {
  /** 지금 메뉴를 띄우고 있는 뷰. 없으면 null. */
  ownerId: ContextMenuOwner | null
  /** 소유권을 가져온다. 이전 소유자는 자기 effect에서 자기 메뉴를 닫는다. */
  open: (id: ContextMenuOwner) => void
  /** 소유자일 때만 해제한다(E3). 아니면 아무 일도 하지 않는다. */
  close: (id: ContextMenuOwner) => void
}

export const useContextMenuStore = create<ContextMenuStore>((set, get) => ({
  ownerId: null,

  open: (id) => {
    set({ ownerId: id })
  },

  close: (id) => {
    // E3: 소유자가 아니면 아무 일도 하지 않는다. 뒤늦게 정리되는 뷰(이미 소유권을 넘긴
    // 쪽)의 onClose가 새 소유자의 메뉴까지 닫아버리는 경쟁 조건을 막는다.
    if (get().ownerId !== id) return
    set({ ownerId: null })
  }
}))
