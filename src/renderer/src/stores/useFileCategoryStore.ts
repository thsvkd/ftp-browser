import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  EMPTY_OVERRIDES,
  resolveCategories,
  sanitizeOverrides,
  type CategoryOverrides,
  type DefaultCategoryId,
  type ResolvedCategory
} from '@renderer/lib/fileCategories'
import {
  addCustom,
  addExtension,
  deleteCustom,
  removeExtension,
  renameCustom,
  restoreAllDefaults,
  restoreCategory,
  setHidden
} from '@renderer/lib/fileCategoryEdit'

interface FileCategoryState {
  /** 기본 목록과의 차이 + 사용자 카테고리. 해석된 목록은 상태가 아니라 파생이다(`selectCategories`). */
  overrides: CategoryOverrides

  /** 같은 카테고리에 이미 있으면 'exists', 다른 카테고리에도 있으면 `duplicateOf`가 붙는다. */
  addExtension: (
    id: string,
    raw: string
  ) => { result: 'added' | 'exists' | 'invalid'; duplicateOf?: string }
  removeExtension: (id: string, ext: string) => void
  setHidden: (id: DefaultCategoryId, hidden: boolean) => void
  restoreCategory: (id: DefaultCategoryId) => void
  restoreAllDefaults: () => void
  /** 새 사용자 카테고리의 id를 돌려준다. 빈 이름이면 만들지 않고 null. */
  addCustom: (name: string) => string | null
  renameCustom: (id: string, name: string) => void
  deleteCustom: (id: string) => void
}

const resolvedCache = new WeakMap<CategoryOverrides, ResolvedCategory[]>()

/** 숨김 포함 전체 목록. 같은 `overrides` 참조면 같은 배열을 돌려준다(셀렉터가 새 배열을 만들지 않게). */
export function selectCategories(s: Pick<FileCategoryState, 'overrides'>): ResolvedCategory[] {
  let list = resolvedCache.get(s.overrides)
  if (!list) {
    list = resolveCategories(s.overrides)
    resolvedCache.set(s.overrides, list)
  }
  return list
}

let seq = 0
const newCustomId = (): string =>
  `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${++seq}`

export const useFileCategoryStore = create<FileCategoryState>()(
  persist(
    (set, get) => ({
      overrides: EMPTY_OVERRIDES,

      addExtension: (id, raw) => {
        const r = addExtension(get().overrides, selectCategories(get()), id, raw)
        if (r.overrides !== get().overrides) set({ overrides: r.overrides })
        return { result: r.result, ...(r.duplicateOf ? { duplicateOf: r.duplicateOf } : {}) }
      },
      removeExtension: (id, ext) =>
        set((s) => ({ overrides: removeExtension(s.overrides, id, ext) })),
      setHidden: (id, hidden) => set((s) => ({ overrides: setHidden(s.overrides, id, hidden) })),
      restoreCategory: (id) => set((s) => ({ overrides: restoreCategory(s.overrides, id) })),
      restoreAllDefaults: () => set((s) => ({ overrides: restoreAllDefaults(s.overrides) })),
      addCustom: (name) => {
        const id = newCustomId()
        const next = addCustom(get().overrides, id, name)
        if (next === get().overrides) return null
        set({ overrides: next })
        return id
      },
      renameCustom: (id, name) => set((s) => ({ overrides: renameCustom(s.overrides, id, name) })),
      deleteCustom: (id) => set((s) => ({ overrides: deleteCustom(s.overrides, id) }))
    }),
    {
      name: 'ftp-browser-file-categories',
      version: 1,
      partialize: (s) => ({ overrides: s.overrides }),
      // 저장분의 다른 키(옛 버전이 남긴 `categories` 등)는 버린다. 기본 목록은 늘 지금 코드에서 계산한다.
      merge: (persisted, current) => ({
        ...current,
        overrides: sanitizeOverrides((persisted as { overrides?: unknown } | null)?.overrides)
      })
    }
  )
)
