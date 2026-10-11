// 탐색기 항목의 표시 문구(종류·짧은 날짜). 타일·행·속성 창·정보 레일이 함께 쓴다.
import { getLocale, t } from '@renderer/i18n'
import { getFileExtension } from '@renderer/lib/utils'
import type { ExplorerEntry } from '@renderer/lib/explorerEntry'

/** "Folder", "Image (JPG)", "TXT file", "File" */
export function typeLabel(e: Pick<ExplorerEntry, 'type' | 'name' | 'isImage'>): string {
  if (e.type === 'directory') return t('fileType.folder')
  if (e.type === 'symbolic-link') return t('fileType.symlink')
  const ext = getFileExtension(e.name).slice(1).toUpperCase()
  if (e.isImage) return t('fileType.image', { ext })
  return ext ? t('fileType.withExtension', { ext }) : t('fileType.file')
}

/** 리스트 열의 짧은 날짜·시각. 읽을 수 없는 시각은 빈 문자열. */
export function shortDate(iso: string): string {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(getLocale(), { dateStyle: 'short', timeStyle: 'short' })
}
