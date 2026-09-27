import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { en } from './locales/en'
import { ko } from './locales/ko'
import { ja } from './locales/ja'
import { zhCN } from './locales/zh-CN'
import { zhTW } from './locales/zh-TW'
import { de } from './locales/de'
import { fr } from './locales/fr'
import { es } from './locales/es'
import { it } from './locales/it'
import { ptBR } from './locales/pt-BR'
import { ru } from './locales/ru'

/** Language picker order. Names are endonyms so users can find their own language in any UI language. */
export const LOCALES = [
  { code: 'en', name: 'English' },
  { code: 'ko', name: '한국어' },
  { code: 'ja', name: '日本語' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' },
  { code: 'it', name: 'Italiano' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'ru', name: 'Русский' }
] as const

export type LocaleCode = (typeof LOCALES)[number]['code']
export type LanguageSetting = 'system' | LocaleCode

type MessageId = keyof typeof en
type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

/** A message key as callers write it: plural variants (`x_one`, `x_other`) collapse to `x`. */
export type MessageKey = MessageId extends infer K
  ? K extends `${infer Base}_${PluralCategory}`
    ? Base
    : K
  : never

/**
 * Every locale must carry every English message. `_one` is optional because CJK plural rules
 * only ever select `other`; extra categories (Russian `_few`/`_many`) are allowed on top.
 */
export type LocaleMessages = {
  [K in MessageId as K extends `${string}_one` ? never : K]: string
} & { [K in MessageId as K extends `${string}_one` ? K : never]?: string } & {
  [id: string]: string | undefined
}

export type MessageVars = Record<string, string | number>

export const MESSAGES: Record<LocaleCode, LocaleMessages> = {
  en,
  ko,
  ja,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  de,
  fr,
  es,
  it,
  'pt-BR': ptBR,
  ru
}

/** Map the OS/browser language list to a supported locale, falling back to English. */
export function resolveLocale(setting: LanguageSetting, preferred: readonly string[]): LocaleCode {
  if (setting !== 'system') return setting
  for (const tag of preferred) {
    const lower = tag.toLowerCase()
    // 홍콩·마카오·Hant 표기는 번체, 나머지 중국어는 간체로 본다.
    if (lower.startsWith('zh')) return /-(tw|hk|mo|hant)\b/.test(lower) ? 'zh-TW' : 'zh-CN'
    if (lower.startsWith('pt')) return 'pt-BR'
    const match = LOCALES.find((l) => l.code === lower.split('-')[0])
    if (match) return match.code
  }
  return 'en'
}

export function translate(locale: LocaleCode, key: MessageKey, vars?: MessageVars): string {
  const lookup = (messages: LocaleMessages | undefined, lang: LocaleCode): string | undefined => {
    if (!messages) return undefined
    if (typeof vars?.count !== 'number') return messages[key]
    const category = new Intl.PluralRules(lang).select(vars.count)
    return messages[`${key}_${category}`] ?? messages[`${key}_other`] ?? messages[key]
  }
  const template = lookup(MESSAGES[locale], locale) ?? lookup(en, 'en') ?? key
  if (!vars) return template
  const number = new Intl.NumberFormat(locale)
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = vars[name]
    if (value === undefined) return match
    return typeof value === 'number' ? number.format(value) : value
  })
}

export function getLocale(): LocaleCode {
  return resolveLocale(useSettingsStore.getState().language, navigator.languages)
}

/** For non-React code (stores, toasts fired from handlers). Components use {@link useT}. */
export function t(key: MessageKey, vars?: MessageVars): string {
  return translate(getLocale(), key, vars)
}

/** Current locale; re-renders the caller when the language setting changes. */
export function useLocale(): LocaleCode {
  const language = useSettingsStore((s) => s.language)
  return resolveLocale(language, navigator.languages)
}

export function useT(): typeof t {
  const locale = useLocale()
  return (key, vars) => translate(locale, key, vars)
}
