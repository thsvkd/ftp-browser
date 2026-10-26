import { useEffect, useState } from 'react'
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
  Unplug,
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
import { connKey, connLabel } from '@shared/connKey'
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
  connKey(s.host, s.port, s.username)

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
  detail,
  small,
  indent
}: {
  loc: Loc
  label: string
  icon: LucideIcon
  title?: string
  /** 이름 뒤의 출처 줄(최근 위치의 원격 항목, same-host-accounts SH5). 있으면 접근 이름에 덧붙인다 */
  detail?: string
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
      aria-label={detail ? `${label} · ${detail}` : undefined}
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
          // 출처 줄이 있으면 이름이 제 너비를 갖고 출처 줄이 남는 폭을 쓴다(출처 줄이 먼저 잘린다)
          'min-w-0 truncate',
          !detail && 'flex-1',
          small ? 'text-[12.5px] text-[var(--mu)]' : 'text-[13px]'
        )}
      >
        {label}
      </span>
      {detail && (
        <span className="mono min-w-0 flex-1 truncate text-[10.5px] text-[var(--mu)]">
          {detail}
        </span>
      )}
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
 * 서버 한 줄(MC14·D3·D8): 상태 점, 연결됐으면 주소, 아니면 상태 안내와 연결 힌트(D7). 연결된
 * 서버를 누르면 그 서버의 루트로 활성 탭이 가고, 미연결 저장 서버는 클릭=선택, 더블클릭·Enter=
 * 연결이다. 연결 시작을 막는 것은 스토어의 재진입 가드이므로 행을 비활성화하지 않는다(함정 C).
 * 연결된 행에는 그 서버만 끊는 버튼이 있다(행에 마우스·포커스가 있을 때 보인다).
 */
function ServerRow({
  name,
  sub,
  status,
  saved,
  server,
  onDisconnect,
  root
}: {
  name: string
  sub: string
  status: ConnectionStatus
  /** 저장된 서버면 클릭은 선택만, 더블클릭·Enter는 연결(D3·D8). 없으면 지금 연결의 행이다. */
  saved?: FtpServer
  /** 서버 키 `"user@host:port"`. 저장되지 않은 행의 클릭·Enter가 이걸로 바로 연결한다. */
  server: string
  onDisconnect: () => void
  root: Loc | null
}): React.JSX.Element {
  const t = useT()
  const { navigate, openTab } = useTabsStore.getState()
  const { select } = useServerStore.getState()
  const drop = useDropTarget(`server:${root ? locKey(root) : name}`, root, {
    spring: () => root && navigate(root),
    springMs: SPRING_MS
  })
  return (
    <div className="group relative shrink-0">
      <button
        onClick={(e) => {
          if (root) {
            if (e.ctrlKey || e.metaKey) openTab(root)
            else navigate(root)
            return
          }
          // D3: 클릭은 선택만. 저장되지 않은 지금 연결 행만 예전처럼 바로 연결한다.
          if (saved) select(saved)
          else connectToServer(server)
        }}
        onDoubleClick={() => {
          if (root || !saved) return
          void connectSaved(saved)
        }}
        onKeyDown={(e) => {
          // D8: Enter는 더블클릭의 키보드 등가물. 연결된 행의 Enter는 기본 동작(=클릭)에 맡긴다.
          if (e.key !== 'Enter' || root) return
          e.preventDefault()
          if (saved) void connectSaved(saved)
          else connectToServer(server)
        }}
        onAuxClick={(e) => e.button === 1 && root && openTab(root, false)}
        onDragOver={drop.handlers.onDragOver}
        onDrop={drop.handlers.onDrop}
        title={
          drop.over
            ? drop.valid
              ? `${drop.verb} → ${name}`
              : (drop.reason ?? '')
            : status === 'connected'
              ? sub
              : // D7: 규칙이 바뀌었으니 미연결 행에는 기존 연결 힌트를 덧붙인다(새 i18n 키 없이).
                `${sub} · ${t('servers.hint')}`
        }
        className={cn(
          'relative flex h-11 w-full shrink-0 items-center gap-2.5 rounded-[10px] px-2 text-left text-[var(--tx)] transition-colors hover:bg-[var(--hv)]',
          status === 'connected' && 'pr-9',
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
      {status === 'connected' && (
        <button
          onClick={onDisconnect}
          aria-label={t('sidebar.disconnect', { name: sub })}
          title={t('sidebar.disconnect', { name: sub })}
          className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-[var(--mu)] opacity-0 transition-opacity hover:bg-[var(--hv)] hover:text-[var(--dg)] focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
        >
          <Unplug className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </div>
  )
}

/** 한 서버의 행과, 연결됐으면 그 연결의 최근 폴더 4개(`ftp:getRecentPaths(key)`). */
function ServerEntry({ row }: { row: ServerRowData }): React.JSX.Element {
  const status = useFtpStore((s) => s.connections[row.key]?.status ?? 'disconnected')
  const connected = status === 'connected'
  const [recent, setRecent] = useState<string[]>([])

  useEffect(() => {
    if (!connected) return
    let current = true
    window.api
      .invoke<IpcResult<RecentPath[]>>('ftp:getRecentPaths', row.key)
      .then((r) => current && r.success && setRecent(r.data.slice(0, 4).map((p) => p.path)))
      .catch(() => undefined)
    // 끊기거나 키가 바뀌면 그 연결의 폴더를 지운다
    return () => {
      current = false
      setRecent([])
    }
  }, [connected, row.key])

  const root: Loc | null = connected ? { side: 'remote', path: '/', server: row.key } : null
  return (
    <>
      <ServerRow
        name={row.name}
        sub={connLabel(row.key)}
        status={status}
        root={root}
        saved={row.saved}
        server={row.key}
        onDisconnect={() => void useFtpStore.getState().disconnect(row.key)}
      />
      {root &&
        recent.map((path) => {
          const loc: Loc = { ...root, path }
          return <Place key={path} loc={loc} label={locLabel(loc)} icon={Folder} indent />
        })}
    </>
  )
}

interface ServerRowData {
  key: string
  name: string
  host: string
  port: number
  saved?: FtpServer
}

/**
 * 저장된 서버들. 저장되지 않은 주소의 연결(연결 중·연결됨·끊김)은 모두 맨 위에 보인다. 끊긴
 * (`disconnected`) 저장 안 된 연결은 그리지 않는다(돌아갈 곳은 최근 위치에 있다).
 */
function Servers(): React.JSX.Element {
  const servers = useServerStore((s) => s.servers)
  // 저장 안 된 살아 있는 연결의 "키 호스트 포트" 줄들. 문자열 하나라 진행 중 갱신에 다시 그리지 않는다.
  const unsaved = useFtpStore((s) =>
    Object.entries(s.connections)
      .filter(([k, c]) => c.status !== 'disconnected' && !servers.some((sv) => serverKey(sv) === k))
      .map(([k, c]) => [k, c.host, c.port].join('\t'))
      .join('\n')
  )

  const rows: ServerRowData[] = [
    ...(unsaved
      ? unsaved.split('\n').map((line) => {
          const [key, host, port] = line.split('\t')
          // 이름은 키 이름표에서 끝의 `:port`를 뗀 것(같은 호스트의 다른 계정도 구별, SH4)
          const label = connLabel(key)
          return { key, name: label.slice(0, label.lastIndexOf(':')), host, port: Number(port) }
        })
      : []),
    ...servers.map((s) => ({
      key: serverKey(s),
      name: s.name || s.host,
      host: s.host,
      port: s.port,
      saved: s
    }))
  ]

  return (
    <>
      {rows.map((row) => (
        <ServerEntry key={row.key} row={row} />
      ))}
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
      className="scroll flex w-full shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--bd)] bg-[var(--sb)] px-3 py-3"
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
          {recent.slice(0, 5).map((loc) => {
            // 원격 항목은 출처 줄로 어느 연결의 폴더인지 보인다(SH5). 로컬은 지금 그대로
            const source = loc.side === 'remote' && loc.server ? connLabel(loc.server) : undefined
            return (
              <Place
                key={locKey(loc)}
                loc={loc}
                label={locLabel(loc)}
                icon={Clock}
                title={source ? `${source} · ${loc.path}` : loc.path}
                detail={source}
                small
              />
            )
          })}
        </>
      )}
    </nav>
  )
}
