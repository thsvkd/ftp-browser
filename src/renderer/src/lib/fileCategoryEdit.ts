/**
 * 설정 "파일 카테고리"의 편집 동작. 입력을 바꾸지 않고 새 객체를 돌려주는 순수 리듀서다(E27, E28).
 * 기본 카테고리는 기본 목록과의 차이(`added`/`removed`/`hidden`)만 저장한다(E13).
 */
import {
  DEFAULT_CATEGORIES,
  normalizeExtension,
  type CategoryOverrides,
  type DefaultCategoryId,
  type DefaultEdit,
  type ResolvedCategory
} from './fileCategories'

export interface AddExtensionResult {
  overrides: CategoryOverrides
  result: 'added' | 'exists' | 'invalid'
  /** 다른 카테고리에도 이미 있을 때 그 카테고리 id */
  duplicateOf?: string
}

const NO_EDIT: DefaultEdit = { added: [], removed: [], hidden: false }

const defaultIds = new Set<string>(DEFAULT_CATEGORIES.map((d) => d.id))
const isDefaultId = (id: string): id is DefaultCategoryId => defaultIds.has(id)
const baseOf = (id: DefaultCategoryId): readonly string[] =>
  DEFAULT_CATEGORIES.find((d) => d.id === id)?.extensions ?? []

function editDefault(
  o: CategoryOverrides,
  id: DefaultCategoryId,
  patch: (e: DefaultEdit) => Partial<DefaultEdit>
): CategoryOverrides {
  const edit = o.defaults[id] ?? NO_EDIT
  return { ...o, defaults: { ...o.defaults, [id]: { ...edit, ...patch(edit) } } }
}

function editCustom(
  o: CategoryOverrides,
  id: string,
  patch: (extensions: string[]) => string[]
): CategoryOverrides {
  return {
    ...o,
    custom: o.custom.map((c) => (c.id === id ? { ...c, extensions: patch(c.extensions) } : c))
  }
}

/** `categories`는 해석된 목록(숨김 포함)이다. 같은 카테고리에 있으면 'exists', 정규화 실패는 'invalid'. */
export function addExtension(
  o: CategoryOverrides,
  categories: ResolvedCategory[],
  id: string,
  raw: string
): AddExtensionResult {
  const ext = normalizeExtension(raw)
  const target = categories.find((c) => c.id === id)
  if (ext === null || !target) return { overrides: o, result: 'invalid' }
  if (target.extensions.includes(ext)) return { overrides: o, result: 'exists' }
  const duplicateOf = categories.find((c) => c.id !== id && c.extensions.includes(ext))?.id
  const overrides = isDefaultId(id)
    ? editDefault(o, id, (e) =>
        e.removed.includes(ext)
          ? { removed: e.removed.filter((x) => x !== ext) }
          : { added: [...e.added, ext] }
      )
    : editCustom(o, id, (list) => [...list, ext])
  return { overrides, result: 'added', ...(duplicateOf ? { duplicateOf } : {}) }
}

/** 기본 확장자를 지우면 `removed`에 들어가고, 더해 둔 것을 지우면 `added`에서 빠진다. */
export function removeExtension(o: CategoryOverrides, id: string, raw: string): CategoryOverrides {
  const ext = normalizeExtension(raw) ?? raw
  if (!isDefaultId(id)) return editCustom(o, id, (list) => list.filter((x) => x !== ext))
  return editDefault(o, id, (e) => ({
    added: e.added.filter((x) => x !== ext),
    removed:
      baseOf(id).includes(ext) && !e.removed.includes(ext) ? [...e.removed, ext] : e.removed
  }))
}

export function setHidden(
  o: CategoryOverrides,
  id: DefaultCategoryId,
  hidden: boolean
): CategoryOverrides {
  return editDefault(o, id, () => ({ hidden }))
}

/** 그 기본 카테고리의 편집(`added`·`removed`·`hidden`)을 모두 지운다. */
export function restoreCategory(o: CategoryOverrides, id: DefaultCategoryId): CategoryOverrides {
  const defaults = { ...o.defaults }
  delete defaults[id]
  return { ...o, defaults }
}

/** 기본 7개만 되돌리고 사용자 카테고리는 남긴다. */
export function restoreAllDefaults(o: CategoryOverrides): CategoryOverrides {
  return { ...o, defaults: {} }
}

/** 이름은 앞뒤 공백을 자른다. 빈 이름은 거부(`o` 그대로). 이름 중복은 허용한다. */
export function addCustom(o: CategoryOverrides, id: string, name: string): CategoryOverrides {
  const trimmed = name.trim()
  if (!trimmed) return o
  return { ...o, custom: [...o.custom, { id, name: trimmed, extensions: [] }] }
}

export function renameCustom(o: CategoryOverrides, id: string, name: string): CategoryOverrides {
  const trimmed = name.trim()
  if (!trimmed) return o
  return { ...o, custom: o.custom.map((c) => (c.id === id ? { ...c, name: trimmed } : c)) }
}

export function deleteCustom(o: CategoryOverrides, id: string): CategoryOverrides {
  return { ...o, custom: o.custom.filter((c) => c.id !== id) }
}
