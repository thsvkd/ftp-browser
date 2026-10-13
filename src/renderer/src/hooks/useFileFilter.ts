import { useMemo } from 'react'
import { useT, type MessageKey } from '@renderer/i18n'
import {
  createMatcher,
  visibleCategories,
  type EntryMatcher,
  type ResolvedCategory,
  type TabFilter
} from '@renderer/lib/fileCategories'
import { selectCategories, useFileCategoryStore } from '@renderer/stores/useFileCategoryStore'

// 셀렉터는 저장된 참조(`overrides`)만 고른다. 파생 배열은 여기서 메모해 zustand 5가 매번 다른 스냅샷을
// 보고 렌더 루프에 빠지지 않게 한다.

/** 설정용: 숨긴 기본 카테고리까지 모두. */
export function useAllCategories(): ResolvedCategory[] {
  const overrides = useFileCategoryStore((s) => s.overrides)
  return useMemo(() => selectCategories({ overrides }), [overrides])
}

/** 필터가 쓰는, 보이는 카테고리. */
export function useCategories(): ResolvedCategory[] {
  const all = useAllCategories()
  return useMemo(() => visibleCategories(all), [all])
}

/** 카테고리 이름: 기본은 번역 키, 사용자 카테고리는 입력한 문자열. */
export function useCategoryName(): (c: ResolvedCategory) => string {
  const t = useT()
  return (c) => (c.kind === 'default' ? t(c.nameKey as MessageKey) : (c.name ?? ''))
}

/** 탭 필터의 매처. 필터가 없으면 null. `filter`는 통째로 교체되는 값이어야 메모가 먹는다. */
export function useTabMatcher(filter: TabFilter): EntryMatcher | null {
  const categories = useAllCategories()
  return useMemo(() => createMatcher(filter, categories), [filter, categories])
}
