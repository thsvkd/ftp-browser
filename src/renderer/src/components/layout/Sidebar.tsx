import { Fragment, useEffect, useState } from 'react'
import {
  Clock,
  Download,
  FileText,
  Film,
  Folder,
  HardDrive,
  ImageIcon,
  Monitor,
  Music,
  type LucideIcon
} from 'lucide-react'
import { useT, type MessageKey } from '@renderer/i18n'
import { locKey, sameLoc, type Loc } from '@renderer/lib/explorerEntry'
import { SPRING_MS } from '@renderer/lib/explorerLayout'
import { connectSaved, connectToServer, loadPlaces, locLabel } from '@renderer/lib/sendItems'
import { cn } from '@renderer/lib/utils'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useActiveTab, useTabsStore } from '@renderer/stores/useTabsStore'
import { SourceBadge } from '@renderer/components/common/SourceBadge'
import { useDropTarget } from '@renderer/components/explorer/dnd'
import type { ConnectionStatus, FtpServer, RecentPath } from '@shared/types/ftp'
import type { IpcResult } from '@shared/types/ipc'
import type { LocalPlaces } from '@shared/types/local'

const PLACES: Array<[Exclude<keyof LocalPlaces, 'home' | 'roots'>, MessageKey, LucideIcon]> = [
  ['desktop', 'place.desktop', Monitor],
  ['downloads', 'place.downloads', Download],
  ['documents', 'place.documents', FileText],
  ['pictures', 'place.pictures', ImageIcon],
  ['music', 'place.music', Music],
  ['videos', 'place.videos', Film]
]

const STATUS_DOT: Record<ConnectionStatus, string> = {
  connected: 'bg-[var(--ok)]',
  connecting: 'animate-pulse bg-[var(--sh)]',
  error: 'bg-[var(--dg)]',
  disconnected: 'bg-[var(--bd2)]'
}

const STATUS_SUB: Record<Exclude<ConnectionStatus, 'connected'>, MessageKey> = {
  connecting: 'sidebar.serverConnecting',
  error: 'sidebar.serverLost',
  disconnected: 'sidebar.serverOffline'
}

/** 서버 키 `"user@host:port"`(D1). 익명은 'anonymous'로 접속한다(useServerStore.connect). */
const serverKey = (s: Pick<FtpServer, 'username' | 'host' | 'port'>): string =>
  `${s.username || 'anonymous'}@${s.host}:${s.port}`

function Heading({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="mb-1 mt-4 px-2 text-[11.5px] font-bold tracking-wide text-[var(--mu)] first:mt-0">
      {children}
    </div>
  )
}

/** 장소 한 줄: 누르면 활성 탭 이동, Ctrl+클릭·가운데 클릭은 새 탭. 끌어 놓으면 그리로 보내고 머무르면 연다. */
function Place({
  loc,
  label,
  icon: Icon,
  title,
  small,
  indent
}: {
  loc: Loc
  label: string
  icon: LucideIcon
  title?: string
  small?: boolean
  indent?: boolean
}): React.JSX.Element {
  const tab = useActiveTab()
  const { navigate, openTab } = useTabsStore.getState()
  const drop = useDropTarget(`place:${locKey(loc)}`, loc, {
    spring: () => navigate(loc),
    springMs: SPRING_MS
  })
  // 최근 위치는 "지금 위치"로 표시하지 않는다(장소와 겹친다).
  const here = !small && !!tab && sameLoc(tab.loc, loc)
  return (
    <button
      onClick={(e) => (e.ctrlKey || e.metaKey ? openTab(loc) : navigate(loc))}
      onAuxClick={(e) => e.button === 1 && openTab(loc, false)}
      onDragOver={drop.handlers.onDragOver}
      onDrop={drop.handlers.onDrop}
      aria-current={here ? 'location' : undefined}
      title={
        drop.over
          ? drop.valid
            ? `${drop.verb} → ${label}`
            : (drop.reason ?? '')
          : (title ?? loc.path)
      }
      className={cn(
        'relative flex w-full shrink-0 items-center gap-2.5 rounded-[10px] px-2 text-left transition-colors',
        small ? 'h-8' : 'h-9',
        indent && 'pl-5',
        here
          ? 'bg-[var(--sf)] font-semibold text-[var(--tx)] shadow-[0_1px_2px_rgba(0,0,0,.06)]'
          : 'text-[var(--tx)] hover:bg-[var(--hv)]',
        drop.over &&
          (drop.valid ? 'bg-[var(--acw)] ring-2 ring-[var(--ac)]' : 'ring-2 ring-[var(--dg)]')
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          'shrink-0',
          small ? 'h-3.5 w-3.5' : 'h-[18px] w-[18px]',
          here ? 'text-[var(--ac)]' : 'text-[var(--mu)]'
        )}
        strokeWidth={1.75}
      />
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          small ? 'text-[12.5px] text-[var(--mu)]' : 'text-[13px]'
        )}
      >
        {label}
      </span>
      {drop.over && (
        <span
          aria-hidden
          className="spring-fill absolute inset-x-2 bottom-0.5 h-[3px] rounded-full bg-[var(--ac)]"
        />
      )}
    </button>
  )
}

/**
 * 서버 한 줄(D6): 상태 점, 연결됐으면 주소, 아니면 상태 안내. 연결된 서버를 누르면 그 서버의 루트로
 * 활성 탭이 가고, 그 밖에는 연결한다(끊겼으면 다시 연결).
 */
function ServerRow({
  name,
  sub,
  status,
  onActivate,
  root
}: {
  name: string
  sub: string
  status: ConnectionStatus
  onActivate: () => void
  root: Loc | null
}): React.JSX.Element {
  const t = useT()
  const { navigate, openTab } = useTabsStore.getState()
  const drop = useDropTarget(`server:${root ? locKey(root) : name}`, root, {
    spring: () => root && navigate(root),
    springMs: SPRING_MS
  })
  return (
    <button
      onClick={(e) => {
        if (!root) return onActivate()
        if (e.ctrlKey || e.metaKey) openTab(root)
        else navigate(root)
      }}
      onAuxClick={(e) => e.button === 1 && root && openTab(root, false)}
      onDragOver={drop.handlers.onDragOver}
      onDrop={drop.handlers.onDrop}
      disabled={status === 'connecting'}
      title={drop.over ? (drop.valid ? `${drop.verb} → ${name}` : (drop.reason ?? '')) : sub}
      className={cn(
        'relative flex h-11 w-full shrink-0 items-center gap-2.5 rounded-[10px] px-2 text-left text-[var(--tx)] transition-colors hover:bg-[var(--hv)] disabled:cursor-wait',
        drop.over &&
          (drop.valid ? 'bg-[var(--acw)] ring-2 ring-[var(--ac)]' : 'ring-2 ring-[var(--dg)]')
      )}
    >
      <span className={cn('relative', status === 'disconnected' && 'opacity-70')}>
        <SourceBadge side="remote" />
        <span
          data-status={status}
          aria-hidden
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--sb)]',
            STATUS_DOT[status]
          )}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-4">{name}</span>
        <span
          className={cn(
            'block truncate text-[10.5px] leading-4 text-[var(--mu)]',
            status === 'connected' && 'mono'
          )}
        >
          {status === 'connected' ? sub : t(STATUS_SUB[status])}
        </span>
      </span>
    </button>
  )
}

/** 저장된 서버들. 지금 연결이 저장되지 않은 주소면 맨 위에 그 연결을 보인다. 연결된 서버는 최근 폴더 4개를 펼친다. */
function Servers(): React.JSX.Element {
  const servers = useServerStore((s) => s.servers)
  const status = useFtpStore((s) => s.connectionStatus)
  const host = useFtpStore((s) => s.host)
  const port = useFtpStore((s) => s.port)
  const username = useFtpStore((s) => s.username)
  const live = status !== 'disconnected' && host ? serverKey({ username, host, port }) : null
  const connected = status === 'connected' ? live : null
  const [recent, setRecent] = useState<string[]>([])

  useEffect(() => {
    setRecent([])
    if (!connected) return
    let current = true
    window.api
      .invoke<IpcResult<RecentPath[]>>('ftp:getRecentPaths', host, port)
      .then((r) => current && r.success && setRecent(r.data.slice(0, 4).map((p) => p.path)))
      .catch(() => undefined)
    return () => {
      current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- host·port는 connected 키에 들어 있다
  }, [connected])

  const rows: Array<{ key: string; name: string; sub: string; saved?: FtpServer }> = [
    ...(live && !servers.some((s) => serverKey(s) === live)
      ? [{ key: live, name: host, sub: `${host}:${port}` }]
      : []),
    ...servers.map((s) => ({
      key: serverKey(s),
      name: s.name || s.host,
      sub: `${s.host}:${s.port}`,
      saved: s
    }))
  ]

  return (
    <>
      {rows.map((row) => {
        const rowStatus = row.key === live ? status : 'disconnected'
        const root: Loc | null =
          rowStatus === 'connected' ? { side: 'remote', path: '/', server: row.key } : null
        return (
          <Fragment key={row.key}>
            <ServerRow
              name={row.name}
              sub={row.sub}
              status={rowStatus}
              root={root}
              onActivate={() => (row.saved ? connectSaved(row.saved) : connectToServer(row.key))}
            />
            {root &&
              recent.map((path) => {
                const loc: Loc = { ...root, path }
                return <Place key={path} loc={loc} label={locLabel(loc)} icon={Folder} indent />
              })}
          </Fragment>
        )
      })}
    </>
  )
}

/** 사이드바(D6·D7): 내 PC 장소와 드라이브, 저장된 서버, 최근 위치. */
export function Sidebar(): React.JSX.Element {
  const t = useT()
  const recent = useTabsStore((s) => s.recent)
  const [places, setPlaces] = useState<LocalPlaces | null>(null)

  useEffect(() => {
    let current = true
    void loadPlaces().then((p) => current && setPlaces(p))
    return () => {
      current = false
    }
  }, [])

  return (
    <nav
      aria-label={t('sidebar.label')}
      data-region="sidebar"
      className="scroll flex w-[220px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--bd)] bg-[var(--sb)] px-3 py-3"
    >
      <Heading>{t('sidebar.thisPc')}</Heading>
      {places &&
        PLACES.map(([key, label, icon]) => {
          const path = places[key]
          return path ? (
            <Place key={key} loc={{ side: 'local', path }} label={t(label)} icon={icon} />
          ) : null
        })}
      {places?.roots.map((path) => {
        const loc: Loc = { side: 'local', path }
        return <Place key={path} loc={loc} label={locLabel(loc)} icon={HardDrive} />
      })}

      <Heading>{t('sidebar.servers')}</Heading>
      <Servers />

      {recent.length > 0 && (
        <>
          <Heading>{t('sidebar.recent')}</Heading>
          {recent.slice(0, 5).map((loc) => (
            <Place
              key={locKey(loc)}
              loc={loc}
              label={locLabel(loc)}
              icon={Clock}
              title={loc.path}
              small
            />
          ))}
        </>
      )}
    </nav>
  )
}
