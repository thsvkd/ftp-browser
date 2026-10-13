import { Minus, Plus } from 'lucide-react'
import { useT } from '@renderer/i18n'
import { useTabEntries } from '@renderer/hooks/useTabEntries'
import { TILE_MAX, TILE_MIN, TILE_STEP } from '@renderer/lib/explorerLayout'
import { cn, formatBytes } from '@renderer/lib/utils'
import { useConnectedKeys } from '@renderer/lib/connections'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useActiveTab } from '@renderer/stores/useTabsStore'
import { ZOOM_STEP } from '@renderer/components/explorer/FileGrid'

const fileBytes = (sum: number, e: { type: string; size: number }): number =>
  sum + (e.type === 'file' ? e.size : 0)

const STATUS_DOT = {
  connected: 'bg-[var(--ok)]',
  connecting: 'animate-pulse bg-[var(--sh)]',
  error: 'bg-[var(--dg)]',
  disconnected: 'bg-[var(--bd2)]'
} as const

const tileBtn =
  'flex h-6 w-6 items-center justify-center rounded text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]'

/**
 * 상태 표시줄(D19): 선택 수·크기(없으면 보이는 항목 수), 폴더·파일 합계와 크기, 숨긴 수,
 * 그리드일 때 타일 크기, 활성 탭 서버의 연결 상태(로컬 탭이면 연결된 서버 수). 캐시 통계는 설정 창에만 있다.
 */
export function StatusBar(): React.JSX.Element {
  const t = useT()
  const tab = useActiveTab()
  const { all, visible, selected } = useTabEntries(tab)
  const tileSize = useSettingsStore((s) => s.tileSize)
  // 활성 탭이 원격이면 그 탭 서버의 상태, 로컬이면 연결된 서버 수(MC15)
  const server = tab?.loc.side === 'remote' ? tab.loc.server : undefined
  const conn = useFtpStore((s) => (server ? s.connections[server] : undefined))
  const connectedCount = useConnectedKeys().size
  const status = server
    ? (conn?.status ?? 'disconnected')
    : connectedCount
      ? 'connected'
      : 'disconnected'
  const host = server ? (conn?.host ?? '') : ''
  const { setTileSize, adjustTileSize } = useSettingsStore.getState()

  const dirs = all.filter((e) => e.type === 'directory').length
  const hidden = all.length - visible.length

  return (
    <footer className="tnum flex h-8 shrink-0 items-center gap-4 border-t border-[var(--bd)] bg-[var(--sb)] px-3 text-[12px] text-[var(--mu)]">
      <span className="flex min-w-0 items-center gap-1.5" aria-live="polite">
        {selected.length ? (
          <b className="shrink-0 font-semibold text-[var(--tx)]">
            {t('status.selected', { count: selected.length })} ·{' '}
            <span className="mono">{formatBytes(selected.reduce(fileBytes, 0))}</span>
          </b>
        ) : (
          <span className="shrink-0">{t('common.itemCount', { count: visible.length })}</span>
        )}
        {all.length > 0 && (
          <span className="truncate">
            · {t('status.folderCount', { count: dirs })} ·{' '}
            {t('status.fileCount', { count: all.length - dirs })} ·{' '}
            <span className="mono">{formatBytes(all.reduce(fileBytes, 0))}</span>
            {hidden > 0 && ` · ${t('status.hidden', { count: hidden })}`}
          </span>
        )}
      </span>
      <span className="flex-1" />
      {tab?.view === 'grid' && (
        <span className="flex items-center gap-1.5" title={t('status.tileTooltip')}>
          <button
            onClick={() => adjustTileSize(-ZOOM_STEP)}
            aria-label={t('status.tileSmaller')}
            className={tileBtn}
          >
            <Minus className="h-3.5 w-3.5" aria-hidden />
          </button>
          <input
            type="range"
            min={TILE_MIN}
            max={TILE_MAX}
            step={TILE_STEP}
            value={tileSize}
            onChange={(e) => setTileSize(Number(e.target.value))}
            aria-label={t('status.tileSize')}
            className="h-1 w-24 accent-[var(--ac)]"
          />
          <button
            onClick={() => adjustTileSize(ZOOM_STEP)}
            aria-label={t('status.tileLarger')}
            className={tileBtn}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </button>
        </span>
      )}
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[status])} aria-hidden />
        {host && status !== 'disconnected' && (
          <span className="mono truncate text-[var(--tx)]">{host}</span>
        )}
        <span className="shrink-0">
          {!server && connectedCount
            ? t('status.connections', { count: connectedCount })
            : t(`status.${status}`)}
        </span>
      </span>
    </footer>
  )
}
