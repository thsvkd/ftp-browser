/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useCategories, useTabMatcher } from '@renderer/hooks/useFileFilter'
import { EMPTY_FILTER, EMPTY_OVERRIDES, type TabFilter } from '@renderer/lib/fileCategories'
import { selectCategories, useFileCategoryStore } from './useFileCategoryStore'

const KEY = 'ftp-browser-file-categories'
const SETTINGS_KEY = 'ftp-browser-settings'
const state = (): ReturnType<typeof useFileCategoryStore.getState> =>
  useFileCategoryStore.getState()
const extsOf = (id: string): string[] =>
  selectCategories(state()).find((c) => c.id === id)?.extensions ?? []

beforeEach(() => {
  localStorage.clear()
  useFileCategoryStore.setState({ overrides: EMPTY_OVERRIDES })
})

describe('useFileCategoryStore persistence', () => {
  it('saves only overrides under its own key, leaves the settings store alone and recomputes defaults after an update', async () => {
    // covers: Test-935
    // 설정 키를 먼저 심어 두고, 카테고리 편집이 그 바이트를 건드리지 않는지 본다.
    const seededSettings = JSON.stringify({ state: { showHidden: true }, version: 2 })
    localStorage.setItem(SETTINGS_KEY, seededSettings)
    state().removeExtension('image', 'png')
    state().addCustom('Docs')

    const saved = JSON.parse(localStorage.getItem(KEY)!)
    expect(saved.version).toBe(1)
    expect(Object.keys(saved.state)).toEqual(['overrides'])
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(seededSettings)

    const before = state().overrides
    useFileCategoryStore.setState({ overrides: EMPTY_OVERRIDES })
    localStorage.setItem(KEY, JSON.stringify(saved))
    await useFileCategoryStore.persist.rehydrate()
    expect(state().overrides).toEqual(before)

    // Corrupt storage leaves a fresh store on its defaults and never throws.
    useFileCategoryStore.setState({ overrides: EMPTY_OVERRIDES })
    localStorage.setItem(KEY, 'not json')
    await expect(useFileCategoryStore.persist.rehydrate()).resolves.not.toThrow()
    expect(state().overrides).toEqual(EMPTY_OVERRIDES)
    localStorage.setItem(KEY, JSON.stringify({ state: 'oops', version: 1 }))
    await useFileCategoryStore.persist.rehydrate()
    expect(state().overrides).toEqual(EMPTY_OVERRIDES)
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: { overrides: { defaults: [], custom: [{ extensions: 5 }] } },
        version: 1
      })
    )
    await useFileCategoryStore.persist.rehydrate()
    expect(state().overrides).toEqual(EMPTY_OVERRIDES)

    // 앱 업데이트 뒤에는 저장된 기본 목록을 되살리지 않고 다시 계산한다.
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: {
          overrides: {
            defaults: { image: { added: [], removed: ['png'], hidden: false } },
            custom: []
          },
          categories: [{ id: 'image', extensions: ['zzz'] }]
        },
        version: 1
      })
    )
    await useFileCategoryStore.persist.rehydrate()
    const image = extsOf('image')
    expect(image).toContain('jpg')
    expect(image).not.toContain('png')
    expect(image).not.toContain('zzz')
    expect(Object.keys(state())).not.toContain('categories')
  })
})

describe('useFileCategoryStore actions and memoisation', () => {
  it('wraps the reducers, keeps custom categories on restore and returns stable references until overrides change', () => {
    // covers: Test-936
    const added = state().addExtension('video', 'png')
    expect(added).toEqual({ result: 'added', duplicateOf: 'image' })
    expect(extsOf('video')).toContain('png')
    expect(state().addExtension('video', 'png').result).toBe('exists')

    const a = state().addCustom('Same')
    const b = state().addCustom('Same')
    expect(a).not.toBe(b)
    expect(state().overrides.custom.map((c) => c.id)).toEqual([a, b])

    state().restoreAllDefaults()
    expect(extsOf('video')).not.toContain('png')
    expect(state().overrides.custom).toHaveLength(2)

    // selectCategories와 훅은 overrides가 바뀔 때까지 같은 참조를 돌려준다.
    const first = selectCategories(state())
    expect(selectCategories(state())).toBe(first)
    state().setHidden('code', true)
    const second = selectCategories(state())
    expect(second).not.toBe(first)
    expect(selectCategories(state())).toBe(second)

    const cats = renderHook(() => useCategories())
    const initial = cats.result.current
    cats.rerender()
    expect(cats.result.current).toBe(initial)
    expect(initial.some((c) => c.id === 'code')).toBe(false)
    act(() => state().setHidden('code', false))
    expect(cats.result.current).not.toBe(initial)
    expect(cats.result.current.some((c) => c.id === 'code')).toBe(true)

    const filter: TabFilter = { ...EMPTY_FILTER, categories: ['image'] }
    const matcher = renderHook(({ f }) => useTabMatcher(f), { initialProps: { f: filter } })
    const m = matcher.result.current
    expect(m).toBeTypeOf('function')
    matcher.rerender({ f: filter })
    expect(matcher.result.current).toBe(m)
    matcher.rerender({ f: { ...filter } })
    expect(matcher.result.current).not.toBe(m)
    expect(renderHook(() => useTabMatcher(EMPTY_FILTER)).result.current).toBeNull()
  })
})
