import type { ReactNode } from 'react'
import { useT } from '@renderer/i18n'
import { parentPath, type ExplorerEntry } from '@renderer/lib/explorerEntry'
import { cn, formatBytes, formatDate } from '@renderer/lib/utils'
import { typeLabel } from './entryText'

function Fact({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 py-1.5">
      <dt className="text-[var(--mu)]">{k}</dt>
      <dd className={cn('min-w-0 [overflow-wrap:anywhere]', mono && 'mono text-[12px]')}>{v}</dd>
    </div>
  )
}

/**
 * 항목의 사실: 종류, 크기(파일만), 수정 시각, 위치, 전체 경로, 권한(원격에 있을 때).
 * 속성 창과 정보 레일이 같은 목록을 쓴다.
 */
export function EntryFacts({ entry }: { entry: ExplorerEntry }): React.JSX.Element {
  const t = useT()
  return (
    <dl className="text-[13px]">
      <Fact k={t('file.type')} v={typeLabel(entry)} />
      {entry.type === 'file' && (
        <Fact
          k={t('file.size')}
          mono
          v={t('properties.sizeValue', { size: formatBytes(entry.size), count: entry.size })}
        />
      )}
      {entry.modifiedAt && <Fact k={t('file.modified')} v={formatDate(entry.modifiedAt)} />}
      <Fact
        k={t('properties.location')}
        mono
        v={parentPath(entry.side, entry.path) ?? entry.path}
      />
      <Fact k={t('properties.fullPath')} mono v={entry.path} />
      {entry.permissions && <Fact k={t('properties.permissions')} mono v={entry.permissions} />}
    </dl>
  )
}
