import { describe, expect, it } from 'vitest'
import {
  addCustom,
  addExtension,
  deleteCustom,
  removeExtension,
  renameCustom,
  restoreAllDefaults,
  restoreCategory,
  setHidden
} from './fileCategoryEdit'
import { EMPTY_OVERRIDES, resolveCategories, type CategoryOverrides } from './fileCategories'

const extsOf = (o: CategoryOverrides, id: string): string[] =>
  resolveCategories(o).find((c) => c.id === id)?.extensions ?? []

describe('addExtension / removeExtension', () => {
  it('records defaults as removed/added deltas and reports exists, invalid and duplicates', () => {
    // covers: Test-931
    const base = EMPTY_OVERRIDES
    const cats = resolveCategories(base)

    const removed = removeExtension(base, 'image', 'png')
    expect(removed.defaults.image).toEqual({ added: [], removed: ['png'], hidden: false })
    expect(extsOf(removed, 'image')).not.toContain('png')

    const back = addExtension(removed, resolveCategories(removed), 'image', '.PNG')
    expect(back.result).toBe('added')
    expect(back.overrides.defaults.image?.removed).toEqual([])
    expect(back.overrides.defaults.image?.added).toEqual([])
    expect(extsOf(back.overrides, 'image')).toContain('png')

    const added = addExtension(base, cats, 'image', 'heics')
    expect(added.result).toBe('added')
    expect(added.duplicateOf).toBeUndefined()
    expect(added.overrides.defaults.image).toEqual({
      added: ['heics'],
      removed: [],
      hidden: false
    })
    const gone = removeExtension(added.overrides, 'image', 'heics')
    expect(gone.defaults.image?.added).toEqual([])
    expect(gone.defaults.image?.removed).toEqual([])

    const exists = addExtension(base, cats, 'raw', 'RAF')
    expect(exists.result).toBe('exists')
    expect(exists.overrides).toBe(base)
    expect(addExtension(base, cats, 'raw', 'a/b').result).toBe('invalid')
    expect(addExtension(base, cats, 'nope', 'abc').result).toBe('invalid')

    const dup = addExtension(base, cats, 'video', 'png')
    expect(dup.result).toBe('added')
    expect(dup.duplicateOf).toBe('image')
    expect(extsOf(dup.overrides, 'video')).toContain('png')

    const frozen = JSON.stringify(base)
    addExtension(base, cats, 'video', 'png')
    removeExtension(base, 'image', 'png')
    expect(JSON.stringify(base)).toBe(frozen)
  })
})

describe('setHidden / restoreCategory / restoreAllDefaults', () => {
  it('hides defaults and restores one or all without touching custom categories', () => {
    // covers: Test-932
    let o = setHidden(EMPTY_OVERRIDES, 'code', true)
    expect(resolveCategories(o).find((c) => c.id === 'code')?.hidden).toBe(true)
    o = setHidden(o, 'code', false)
    expect(resolveCategories(o).find((c) => c.id === 'code')?.hidden).toBe(false)

    o = addCustom(EMPTY_OVERRIDES, 'custom-1', 'Mine')
    o = removeExtension(o, 'image', 'png')
    o = setHidden(o, 'image', true)
    o = removeExtension(o, 'raw', 'cr2')
    const one = restoreCategory(o, 'image')
    expect(one.defaults.image).toBeUndefined()
    expect(one.defaults.raw?.removed).toEqual(['cr2'])
    expect(one.custom).toEqual(o.custom)

    const all = restoreAllDefaults(o)
    expect(all.defaults).toEqual({})
    expect(all.custom).toEqual([{ id: 'custom-1', name: 'Mine', extensions: [] }])
  })
})

describe('addCustom / renameCustom / deleteCustom', () => {
  it('trims names, rejects blanks, allows duplicates, keeps id and extensions on rename', () => {
    // covers: Test-933
    let o = addCustom(EMPTY_OVERRIDES, 'custom-1', '  Docs  ')
    expect(o.custom).toEqual([{ id: 'custom-1', name: 'Docs', extensions: [] }])
    expect(addCustom(o, 'custom-x', '   ')).toBe(o)
    o = addCustom(o, 'custom-2', 'Docs')
    expect(o.custom.map((c) => c.name)).toEqual(['Docs', 'Docs'])

    const added = addExtension(o, resolveCategories(o), 'custom-1', 'TXT')
    expect(added.result).toBe('added')
    o = addExtension(
      added.overrides,
      resolveCategories(added.overrides),
      'custom-1',
      'md'
    ).overrides
    expect(extsOf(o, 'custom-1')).toEqual(['txt', 'md'])
    o = removeExtension(o, 'custom-1', 'txt')
    expect(extsOf(o, 'custom-1')).toEqual(['md'])

    const renamed = renameCustom(o, 'custom-1', ' Notes ')
    expect(renamed.custom[0]).toEqual({ id: 'custom-1', name: 'Notes', extensions: ['md'] })
    expect(renameCustom(o, 'custom-1', '  ')).toBe(o)

    const deleted = deleteCustom(o, 'custom-1')
    expect(deleted.custom.map((c) => c.id)).toEqual(['custom-2'])
    expect(resolveCategories(deleted).some((c) => c.id === 'custom-1')).toBe(false)
  })
})
