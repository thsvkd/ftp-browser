import { describe, expect, it } from 'vitest'
import { LOCALES, MESSAGES, resolveLocale, translate } from './index'
import { en } from './locales/en'

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
const pluralBases = [
  ...new Set(
    Object.keys(en)
      .filter((id) => id.endsWith('_other'))
      .map((id) => id.slice(0, -'_other'.length))
  )
]

describe('resolveLocale', () => {
  it('honours an explicit choice over the system languages', () => {
    expect(resolveLocale('ja', ['ko-KR'])).toBe('ja')
  })

  it('maps system languages to the closest supported locale', () => {
    expect(resolveLocale('system', ['ko-KR'])).toBe('ko')
    expect(resolveLocale('system', ['zh-HK'])).toBe('zh-TW')
    expect(resolveLocale('system', ['zh-Hant-TW'])).toBe('zh-TW')
    expect(resolveLocale('system', ['zh-SG'])).toBe('zh-CN')
    expect(resolveLocale('system', ['pt-PT'])).toBe('pt-BR')
    expect(resolveLocale('system', ['nl-NL', 'de-AT'])).toBe('de')
    expect(resolveLocale('system', ['nl-NL'])).toBe('en')
  })
})

describe('translate', () => {
  it('picks the plural form and formats numbers for the locale', () => {
    expect(translate('en', 'delete.confirmTitle', { count: 1 })).toBe('Delete 1 item?')
    expect(translate('en', 'delete.confirmTitle', { count: 1200 })).toBe('Delete 1,200 items?')
  })
})

describe('connect.maxTransfersHint', () => {
  it('says a new limit takes effect from the next connection', () => {
    // 연결 중인 서버의 값을 바꿔도 풀은 다음 연결 때 새 값을 읽는다
    expect(en['connect.maxTransfersHint']).toMatch(/next connection/)
  })
})

describe('locale catalogs', () => {
  it('lists every catalog in the picker', () => {
    expect(Object.keys(MESSAGES).sort()).toEqual(LOCALES.map((l) => l.code).sort())
  })

  for (const { code } of LOCALES) {
    const messages = MESSAGES[code]
    if (!messages) continue

    it(`${code}: keeps the English placeholders in every message`, () => {
      for (const [id, text] of Object.entries(en)) {
        if (id.endsWith('_one')) continue
        expect(messages[id], id).toBeTypeOf('string')
        expect(placeholders(messages[id]!), id).toEqual(placeholders(text))
      }
    })

    it(`${code}: covers every plural category a real count can hit`, () => {
      // fr/es/it/pt의 'many'는 백만 단위에서만 선택되고 없으면 _other로 넘어가므로 필수에서 뺀다.
      const rules = new Intl.PluralRules(code)
      const categories = new Set(Array.from({ length: 201 }, (_, n) => rules.select(n)))
      for (const base of pluralBases) {
        for (const category of categories) {
          // 'one' may legitimately drop {{count}} (e.g. "Delete "{name}"?") — only require presence.
          expect(messages[`${base}_${category}`], `${base}_${category}`).toBeTypeOf('string')
        }
      }
    })
  }
})

const FILE_FILTER_KEYS = [
  'filter.button',
  'filter.buttonTooltip',
  'filter.activeTooltip',
  'filter.menuLabel',
  'filter.advanced',
  'filter.advancedHeading',
  'filter.noExtension',
  'filter.extensionInput',
  'filter.extensionInvalid',
  'filter.removeExtension',
  'filter.emptyFor',
  'filter.clearType',
  'settings.categories',
  'settings.categoriesHint',
  'settings.categoryAdd',
  'settings.categoryNewName',
  'settings.categoryName',
  'settings.categoryDelete',
  'settings.categoryDeleteTitle',
  'settings.categoryHide',
  'settings.categoryShow',
  'settings.categoryHidden',
  'settings.categoryRestore',
  'settings.categoryRestoreAll',
  'settings.categoryRestoreAllTitle',
  'settings.categoryRestoreAllMessage',
  'settings.categoryExtensionAdd',
  'settings.categoryExtensionExists',
  'settings.categoryExtensionDuplicate'
] as const

describe('file category filter messages', () => {
  it('has every new key in every locale and keeps its placeholders', () => {
    // covers: Test-953
    const expected: Record<string, string[]> = {
      'filter.emptyFor': ['what'],
      'filter.activeTooltip': ['n', 'what'],
      'settings.categoryDeleteTitle': ['name'],
      'filter.removeExtension': ['ext'],
      'settings.categoryExtensionExists': ['ext'],
      'settings.categoryExtensionDuplicate': ['ext', 'name']
    }
    for (const { code } of LOCALES) {
      const m = MESSAGES[code] as Record<string, string | undefined>
      for (const key of FILE_FILTER_KEYS) {
        const text = m[key]
        expect(text, `${code} ${key}`).toBeTypeOf('string')
        expect(text!.trim(), `${code} ${key}`).not.toBe('')
        if (expected[key]) expect(placeholders(text!), `${code} ${key}`).toEqual(expected[key])
      }
      // The type-filter button must not share its name with the find box's clear button (E31).
      expect(m['filter.clearType'], code).not.toBe(m['filter.clear'])
    }
  })
})
