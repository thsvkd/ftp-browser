import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`
}

export function formatDate(isoString: string): string {
  if (!isoString) return ''
  const date = new Date(isoString)
  return date.toLocaleString()
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
