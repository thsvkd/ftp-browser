// 탐색 영역의 상태: 첫 로딩 스켈레톤, 분류된 오류·연결 안 됨·다른 서버 패널, 빈 폴더 구별, 끊김 배너.
import type { ReactNode } from 'react'
import {
  ArrowUp,
  FolderOpen,
  FolderPlus,
  ListFilter,
  Loader,
  PackageCheck,
  Plug,
  RefreshCw,
  SearchX,
  ServerOff,
  ShieldAlert,
  Unplug,
  X,
  type LucideIcon
} from 'lucide-react'
import { useT } from '@renderer/i18n'
import { GAP, PAD } from '@renderer/lib/explorerLayout'
import { listErrorActions, listErrorKind } from '@renderer/lib/listError'
import { cn } from '@renderer/lib/utils'
import { NotConnectedPane } from '@renderer/components/server/NotConnectedPane'
import type { ErrorCodeType } from '@shared/types/ipc'

const btn = (kind: 'primary' | 'secondary' | 'shelf'): string =>
  cn(
    'inline-flex h-9 items-center justify-center gap-2 rounded-[10px] px-4 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45',
    kind === 'primary' && 'bg-[var(--ac)] text-[var(--acx)] hover:brightness-110',
    kind === 'secondary' &&
      'border border-[var(--bd)] bg-[var(--sf)] text-[var(--tx)] hover:bg-[var(--hv)]',
    kind === 'shelf' && 'bg-[var(--sh)] text-[var(--shink)] hover:brightness-105'
  )

export function Skeleton({
  grid,
  cols,
  cellWidth,
  imageHeight
}: {
  grid: boolean
  cols: number
  cellWidth: number
  imageHeight: number
}): React.JSX.Element {
  if (!grid)
    return (
      <div className="space-y-1 p-3" aria-hidden data-skeleton>
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="flex h-8 items-center gap-3 px-2">
            <span className="shimmer h-6 w-6 rounded-[5px]" />
            <span className="shimmer h-3 rounded" style={{ width: `${30 + ((i * 37) % 40)}%` }} />
          </div>
        ))}
      </div>
    )
  return (
    <div className="flex flex-wrap" style={{ gap: GAP, padding: PAD }} aria-hidden data-skeleton>
      {Array.from({ length: Math.min(24, cols * 3) }, (_, i) => (
        <div key={i} style={{ width: cellWidth }}>
          <div className="shimmer rounded-[10px]" style={{ height: imageHeight - 8 }} />
          <div className="shimmer mt-2.5 h-3 w-3/4 rounded" />
          <div className="shimmer mt-1.5 h-2.5 w-1/2 rounded" />
        </div>
      ))}
    </div>
  )
}

function Panel({
  icon: Icon,
  tone = 'mu',
  title,
  children,
  actions
}: {
  icon: LucideIcon
  tone?: 'mu' | 'dg' | 'ac'
  title: string
  children?: ReactNode
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-full items-center justify-center p-10" data-nomarquee>
      <div role="status" className="fade flex max-w-[420px] flex-col items-center text-center">
        <span
          className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl"
          style={{
            background: `color-mix(in srgb, var(--${tone}) 14%, transparent)`,
            color: `var(--${tone})`
          }}
        >
          <Icon className="h-7 w-7" strokeWidth={1.75} aria-hidden />
        </span>
        <h3 className="text-[17px] font-bold">{title}</h3>
        {children && (
          <div className="mt-1.5 text-[13px] leading-relaxed text-[var(--mu)]">{children}</div>
        )}
        {actions && <div className="mt-5 flex flex-wrap justify-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}

/** 목록 실패: `IpcResult.code`로 분류한 제목·안내와 종류별 행동(재시도·위로·다시 연결). */
export function ListErrorPanel({
  code,
  error,
  onRetry,
  onUp,
  onReconnect
}: {
  code?: ErrorCodeType
  error?: string
  onRetry: () => void
  onUp: () => void
  onReconnect: () => void
}): React.JSX.Element {
  const t = useT()
  const kind = listErrorKind(code)
  const icon = kind === 'permission' ? ShieldAlert : kind === 'notFound' ? SearchX : Unplug
  const action = {
    retry: (
      <button key="retry" onClick={onRetry} className={btn('primary')}>
        <RefreshCw className="h-4 w-4" aria-hidden /> {t('explorer.retry')}
      </button>
    ),
    up: (
      <button key="up" onClick={onUp} className={btn('secondary')}>
        <ArrowUp className="h-4 w-4" aria-hidden /> {t('explorer.goUp')}
      </button>
    ),
    reconnect: (
      <button key="reconnect" onClick={onReconnect} className={btn('primary')}>
        <Plug className="h-4 w-4" aria-hidden /> {t('explorer.reconnect')}
      </button>
    )
  }
  return (
    <Panel
      icon={icon}
      tone="dg"
      title={t(`listError.${kind}`)}
      actions={listErrorActions(kind).map((a) => action[a])}
    >
      {t(`listError.${kind}Hint`)}
      {error && (
        <code className="mono mt-3 block rounded-lg bg-[var(--bg)] px-3 py-2 text-[11.5px] text-[var(--tx)]">
          {error}
        </code>
      )}
    </Panel>
  )
}

/** 다른 서버의 원격 탭(D2): 목록을 읽지 않고 그 서버에 연결하는 버튼을 보인다. */
export function OtherServerPanel({
  server,
  onConnect
}: {
  server: string
  onConnect: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <Panel
      icon={ServerOff}
      title={t('explorer.otherServer', { server })}
      actions={
        <button onClick={onConnect} className={btn('primary')}>
          <Plug className="h-4 w-4" aria-hidden /> {t('explorer.connectTo', { server })}
        </button>
      }
    >
      {t('explorer.offlineHint')}
    </Panel>
  )
}

/** 연결이 없을 때의 원격 탭: 지금 `NotConnectedPane`(안내 + 최근 서버 칩)을 그대로 그린다. */
export function OfflinePanel({ connecting }: { connecting: boolean }): React.JSX.Element {
  const t = useT()
  return (
    <div className="flex min-h-full flex-col" data-nomarquee>
      {connecting && (
        <div className="flex items-center justify-center gap-2 pt-10 text-[13px] text-[var(--mu)]">
          <Loader className="spin h-4 w-4" aria-hidden /> {t('status.connecting')}
        </div>
      )}
      <NotConnectedPane />
    </div>
  )
}

/** 연결이 끊겼고 지난 목록이 없을 때. */
export function LostPanel({ onReconnect }: { onReconnect: () => void }): React.JSX.Element {
  const t = useT()
  return (
    <Panel
      icon={ServerOff}
      tone="dg"
      title={t('listError.lost')}
      actions={
        <button onClick={onReconnect} className={btn('primary')}>
          <Plug className="h-4 w-4" aria-hidden /> {t('explorer.reconnect')}
        </button>
      }
    >
      {t('listError.lostHint')}
    </Panel>
  )
}

/** 연결이 끊겼을 때 지난 목록 위에 뜨는 배너. */
export function StaleBanner({ onReconnect }: { onReconnect: () => void }): React.JSX.Element {
  const t = useT()
  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-[var(--bd)] bg-[var(--shw)] px-4 py-2 text-[13px]"
    >
      <Unplug className="h-4 w-4 text-[var(--shx)]" aria-hidden />
      <span className="flex-1 font-semibold">{t('explorer.staleBanner')}</span>
      <button
        onClick={onReconnect}
        className="h-7 rounded-lg bg-[var(--sh)] px-3 text-[12px] font-semibold text-[var(--shink)]"
      >
        {t('explorer.reconnect')}
      </button>
    </div>
  )
}

/** 비어 보이는 폴더(기준선 #18): 종류 필터로 숨음 / 찾기 일치 없음 / 정말 빈 폴더를 구별한다. */
export function EmptyPanel(p: {
  query: string
  queryCount: number
  /** 찾기를 통과했지만 파일 종류 필터로 빠진 수 */
  filterCount: number
  /** 필터 요약(`이미지, RAW`) */
  filterText: string
  shelfCount: number
  canWrite: boolean
  onClearQuery: () => void
  onClearFilter: () => void
  onNewFolder: () => void
  onDropShelf: () => void
}): React.JSX.Element {
  const t = useT()
  // 필터를 풀면 항목이 나오는 쪽을 먼저 말한다(E21).
  if (p.filterCount)
    return (
      <Panel
        icon={ListFilter}
        title={t('filter.emptyFor', { what: p.filterText })}
        actions={
          <button onClick={p.onClearFilter} className={btn('secondary')}>
            {t('filter.clearType')}
          </button>
        }
      />
    )
  if (p.query && p.queryCount)
    return (
      <Panel
        icon={SearchX}
        title={t('explorer.noMatch', { query: p.query })}
        actions={
          <button onClick={p.onClearQuery} className={btn('secondary')}>
            <X className="h-4 w-4" aria-hidden /> {t('filter.clear')}
          </button>
        }
      />
    )
  return (
    <Panel
      icon={FolderOpen}
      tone="ac"
      title={t('explorer.empty')}
      actions={
        p.canWrite && (
          <>
            {p.shelfCount > 0 && (
              <button onClick={p.onDropShelf} className={btn('shelf')}>
                <PackageCheck className="h-4 w-4" aria-hidden />{' '}
                {t('menu.dropShelfHere', { count: p.shelfCount })}
              </button>
            )}
            <button onClick={p.onNewFolder} className={btn('secondary')}>
              <FolderPlus className="h-4 w-4" aria-hidden /> {t('explorer.newFolder')}
            </button>
          </>
        )
      }
    />
  )
}
