import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { getLocale, t } from '@renderer/i18n'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

const SIZE_KEYS = ['size.b', 'size.kb', 'size.mb', 'size.gb', 'size.tb'] as const

/** 1024-based size. The number follows the locale; the unit label comes from the catalog (fr "Mo", ru "МБ"). */
export function formatBytes(bytes: number, decimals = 1): string {
  const k = 1024
  const i =
    !Number.isFinite(bytes) || bytes < 1
      ? 0
      : Math.min(SIZE_KEYS.length - 1, Math.floor(Math.log(bytes) / Math.log(k)))
  const value = new Intl.NumberFormat(getLocale(), { maximumFractionDigits: decimals }).format(
    bytes / Math.pow(k, i)
  )
  return t(SIZE_KEYS[i], { value })
}

export function formatDate(isoString: string): string {
  if (!isoString) return ''
  const date = new Date(isoString)
  return date.toLocaleString(getLocale())
}

/** Lower-cased extension including the leading dot, or '' when there is none. */
export function getFileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.substring(dot).toLowerCase() : ''
}

/** A file/dir is "hidden" when its name starts with a dot (Unix/FTP convention). */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.')
}

/**
 * Drop dotfile entries unless `showHidden` is true.
 * Always returns a fresh array so callers can safely sort in place.
 * Works for any entry type that exposes a `name`.
 */
export function filterHidden<T extends { name: string }>(entries: T[], showHidden: boolean): T[] {
  if (showHidden) return [...entries]
  return entries.filter((e) => !isHiddenName(e.name))
}
