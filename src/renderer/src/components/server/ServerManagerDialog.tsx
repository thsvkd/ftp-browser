import { useEffect, useRef, useState } from 'react'
import { Plus, Search, Server as ServerIcon, Trash2, X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useLocale, useT } from '@renderer/i18n'
import { useServerStore } from '@renderer/stores/useServerStore'
import {
  emptyDraft,
  findSaved,
  formatLastConnected,
  isValidPort,
  matchServer,
  resolveDraft,
  sameFields,
  serverAddress,
  serverLabel,
  toDraft,
  type ServerDraft
} from '@renderer/lib/serverAddress'
import { ErrorCode, type IpcResult } from '@shared/types/ipc'
import {
  isValidMaxTransfers,
  type FtpServer,
  type PasswordProtection,
  type RecentPath
} from '@shared/types/ftp'
import { ServerForm } from './ServerForm'
import { ErrorNote, ServerAvatar, Spinner, TlsBadge } from './serverUi'
import { STROKE, arrowIndex, btn, inputCls, onEnterEsc, selectedCls } from './styles'
import { useEscapeKey } from '@renderer/hooks/useEscapeKey'

/**
 * Site manager: saved servers on the left, the selected one's form on the right.
 * Save stores without connecting; Connect connects with the form and closes on success.
 */
export function ServerManagerDialog({
  initial,
  onClose,
  returnFocus
}: {
  /** The server to show first; a draft without `id` opens as a new server. */
  initial: ServerDraft
  onClose: () => void
  /** Where focus goes on close when the element that opened the dialog is gone. */
  returnFocus?: () => void
}): React.JSX.Element {
  const servers = useServerStore((s) => s.servers)
  const connecting = useServerStore((s) => s.connecting)
  const connectingId = useServerStore((s) => s.draft.id)
  const connectError = useServerStore((s) => s.error)
  const { connect, cancel, save, remove, clearError } = useServerStore.getState()
  useEscapeKey(() => (connecting ? cancel() : onClose()))
  const t = useT()
  const locale = useLocale()

  const [query, setQuery] = useState('')
  const [selId, setSelId] = useState<number | 'new'>(initial.id ?? 'new')
  const [draft, setDraft] = useState<ServerDraft>(initial)
  const [recent, setRecent] = useState<RecentPath[]>([])
  const [saveError, setSaveError] = useState('')
  const [protection, setProtection] = useState<PasswordProtection['level']>()
  const listRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  // 렌더 중에 읽어야 autoFocus가 옮기기 전의 포커스(연 버튼)를 잡는다.
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  const [fallbackFocus] = useState(() => returnFocus)

  const list = servers.filter((s) => matchServer(s, query))
  const selected = servers.find((s) => s.id === selId)
  const dirty = selected ? !sameFields(draft, selected) : draft.host.trim() !== ''
  const error = saveError || connectError

  // 저장된 서버를 고르면 그 서버의 최근 경로를 시작 폴더 후보로 가져온다.
  const selHost = selected?.host
  const selPort = selected?.port
  useEffect(() => {
    if (selHost === undefined) {
      setRecent([])
      return
    }
    let stale = false
    window.api
      .invoke<IpcResult<RecentPath[]>>('ftp:getRecentPaths', selHost, selPort)
      .then((result) => {
        if (!stale && result.success) setRecent(result.data)
      })
      .catch((err: unknown) => console.warn('[ServerManager] Failed to load recent paths:', err))
    return () => {
      stale = true
    }
  }, [selHost, selPort])

  // 저장된 비밀번호를 이 컴퓨터가 얼마나 보호하는지 묻는다. 묻지 못하면 경고 없이 둔다(E11).
  useEffect(() => {
    window.api
      .invoke<IpcResult<PasswordProtection>>('ftp:getPasswordProtection')
      .then((result) => {
        if (result.success) setProtection(result.data.level)
      })
      .catch((err: unknown) =>
        console.warn('[ServerManager] Failed to read the password protection:', err)
      )
  }, [])
  const passwordWarning =
    protection === 'basic'
      ? t('servers.passwordProtectionBasic')
      : protection === 'none'
        ? t('servers.passwordProtectionNone')
        : undefined

  // 저장된 서버로 열리면 목록에 포커스를 둬 ↑/↓·Delete가 바로 먹게 한다.
  // 닫히면 연 쪽으로 포커스를 돌려준다(ConfirmDialog와 같은 방식).
  const initialId = initial.id
  useEffect(() => {
    if (initialId !== undefined) listRef.current?.focus()
    clearError()
    return () => {
      if (opener?.isConnected) opener.focus()
      else fallbackFocus?.()
    }
  }, [initialId, clearError, opener, fallbackFocus])

  // 연결 중에는 버튼이 바뀌고 입력칸이 비활성화되어 포커스가 body로 빠진다. 시도가 끝나면
  // (실패·취소) 대화상자로 되돌려 Enter·Esc·Tab 가두기가 다시 먹게 한다.
  const [wasConnecting, setWasConnecting] = useState(connecting)
  if (wasConnecting !== connecting) setWasConnecting(connecting)
  useEffect(() => {
    if (wasConnecting) return
    const active = document.activeElement
    if (!active || active === document.body) dialogRef.current?.focus()
  }, [wasConnecting])

  /** Tab이 대화상자 밖(뒤의 패널)으로 빠져나가지 않게 처음과 끝을 잇는다. */
  const trapTab = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Tab' || !dialogRef.current) return
    const focusable = [
      ...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex="0"]'
      )
    ].filter((el) => el.tabIndex >= 0)
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault()
      last?.focus()
    } else if (!e.shiftKey && (active === last || active === dialogRef.current)) {
      e.preventDefault()
      first?.focus()
    }
  }

  /** main이 준 오류 코드를 현재 언어의 문장으로 바꾼다. */
  const saveErrorText = (result: { error: string; code?: string }): string => {
    if (result.code === ErrorCode.SERVER_EXISTS) {
      return t('servers.exists', { address: serverAddress({ ...draft, username: '' }) })
    }
    if (result.code === ErrorCode.SERVER_NOT_FOUND) return t('servers.notFound')
    if (result.code === ErrorCode.INVALID_PORT) return t('servers.invalidPort')
    if (result.code === ErrorCode.INVALID_MAX_TRANSFERS) return t('servers.invalidMaxTransfers')
    return result.error
  }

  const patch = (fields: Partial<ServerDraft>): void => {
    setDraft((d) => ({ ...d, ...fields }))
    setSaveError('')
    clearError()
  }
  const select = (s: FtpServer): void => {
    if (connecting) return
    setSelId(s.id!)
    setDraft(toDraft(s))
    setSaveError('')
    clearError()
  }
  const addNew = (): void => {
    if (connecting) return
    setSelId('new')
    setDraft(emptyDraft())
    setSaveError('')
    clearError()
  }
  const handleSave = async (): Promise<void> => {
    const result = await save(draft)
    if (!result.success) {
      setSaveError(saveErrorText(result))
      return
    }
    setSelId(result.data.id!)
    setDraft(toDraft(result.data, draft.path))
    // 저장 버튼이 비활성화되며 포커스가 body로 빠지면 Esc·Enter가 대화상자에 닿지 않는다.
    listRef.current?.focus()
  }
  const handleConnect = async (): Promise<void> => {
    if (!draft.host.trim() || connecting) return
    setSaveError('')
    const { server } = resolveDraft(draft)
    if (!isValidPort(server.port)) {
      setSaveError(t('servers.invalidPort'))
      return
    }
    if (!isValidMaxTransfers(server.maxTransfers)) {
      setSaveError(t('servers.invalidMaxTransfers'))
      return
    }
    let target = draft
    if (selected && dirty) {
      // 연결이 main에서 (host, port)로 upsert하므로, 고친 서버는 먼저 id로 저장해야
      // 같은 서버가 두 줄이 되거나 다른 저장된 서버를 덮어쓰지 않는다.
      const result = await save(draft)
      if (!result.success) {
        setSaveError(saveErrorText(result))
        return
      }
      target = toDraft(result.data, draft.path)
      setDraft(target)
    } else if (!selected && findSaved(servers, server.host, server.port)) {
      // 새 서버가 저장된 서버의 주소면 그 서버를 조용히 덮어쓰지 않는다.
      setSaveError(saveErrorText({ error: '', code: ErrorCode.SERVER_EXISTS }))
      return
    }
    if (await connect(target)) onClose()
  }
  const handleDelete = async (): Promise<void> => {
    if (!selected) return
    const i = list.findIndex((s) => s.id === selected.id)
    if (!(await remove(selected))) return
    const next = list[i + 1] ?? list[i - 1]
    if (next) select(next)
    else addNew()
    listRef.current?.focus()
  }

  const onListKey = (e: React.KeyboardEvent): void => {
    const i = list.findIndex((s) => s.id === selId)
    const n = arrowIndex(e.key, i, list.length)
    if (n !== null) {
      e.preventDefault()
      select(list[n])
      listRef.current
        ?.querySelector(`[data-id="${list[n].id}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Delete' && selected) {
      e.preventDefault()
      void handleDelete()
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-gray-900/30 p-6">
      <div
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-label={t('connect.serverManager')}
        className="relative flex h-[580px] max-h-full w-[840px] max-w-full flex-col overflow-hidden rounded-lg bg-white shadow-2xl outline-none ring-1 ring-black/5 motion-safe:animate-pop"
        onKeyDown={(e) => {
          trapTab(e)
          onEnterEsc({ enter: () => void handleConnect() })(e)
        }}
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4">
          <ServerIcon size={16} strokeWidth={STROKE} className="text-gray-500" />
          <h2 className="text-sm font-semibold">{t('connect.serverManager')}</h2>
          <span className="text-xs text-gray-400">
            {t('servers.count', { count: servers.length })}
          </span>
          <div className="flex-1" />
          <button
            className={btn('ghost', 'icon')}
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={() => (connecting ? cancel() : onClose())}
          >
            <X size={16} strokeWidth={STROKE} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[260px] shrink-0 flex-col border-r border-gray-200 bg-gray-50/80">
            <div className="relative p-2">
              <Search
                size={14}
                strokeWidth={STROKE}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    listRef.current?.focus()
                    if (list[0] && !list.some((s) => s.id === selId)) select(list[0])
                  }
                }}
                placeholder={t('servers.searchManager')}
                aria-label={t('servers.searchManager')}
                className={cn(inputCls, 'pl-8')}
              />
            </div>
            <div
              ref={listRef}
              role="listbox"
              tabIndex={0}
              aria-label={t('connect.savedServers')}
              aria-activedescendant={typeof selId === 'number' ? `server-${selId}` : undefined}
              onKeyDown={onListKey}
              className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 focus:outline-none"
            >
              {list.map((s) => {
                const on = s.id === selId
                const last = formatLastConnected(s.lastConnected, locale)
                return (
                  <div
                    key={s.id}
                    id={`server-${s.id}`}
                    data-id={s.id}
                    role="option"
                    aria-selected={on}
                    onClick={() => select(s)}
                    onDoubleClick={() => {
                      select(s)
                      if (!connecting) void connect(toDraft(s)).then((ok) => ok && onClose())
                    }}
                    className={cn(
                      'flex h-12 cursor-default items-center gap-2.5 rounded-md px-2.5',
                      on ? selectedCls : 'hover:bg-gray-100'
                    )}
                  >
                    <ServerAvatar size={24} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium">{serverLabel(s)}</span>
                        {s.secure && <TlsBadge />}
                      </div>
                      <div className="truncate text-[11px] text-gray-500">{serverAddress(s)}</div>
                    </div>
                    {connecting && connectingId === s.id ? (
                      <span className="text-blue-600">
                        <Spinner size={13} />
                      </span>
                    ) : (
                      <span className="shrink-0 self-start pt-[7px] text-[10.5px] text-gray-400">
                        {last ?? '—'}
                      </span>
                    )}
                  </div>
                )
              })}
              {list.length === 0 && (
                <p className="px-3 py-6 text-center text-xs text-gray-400">
                  {query ? t('servers.noMatch', { query }) : t('servers.empty')}
                </p>
              )}
            </div>
            <div className="border-t border-gray-200 p-2">
              <button
                className={cn(
                  btn('ghost', 'md', 'w-full justify-start'),
                  selId === 'new' && selectedCls
                )}
                onClick={addNew}
              >
                <Plus size={14} strokeWidth={STROKE} />
                {t('connect.newServer')}
              </button>
            </div>
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-3">
              <ServerAvatar size={36} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">
                  {serverLabel(draft) || t('connect.newServer')}
                </div>
                <div className="truncate text-xs text-gray-500">
                  {draft.host.trim() ? serverAddress(draft) : t('servers.addressHint')}
                </div>
              </div>
              {dirty && (
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-inset ring-amber-200">
                  {selected ? t('servers.modified') : t('servers.unsaved')}
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <ServerForm
                key={selId}
                draft={draft}
                onPatch={patch}
                recent={recent}
                disabled={connecting}
                autoFocusHost={selId === 'new' && initial.id === undefined}
                passwordWarning={passwordWarning}
              />
            </div>
            {error && (
              <div className="px-5 pb-3">
                <ErrorNote
                  message={error}
                  onClose={() => {
                    setSaveError('')
                    clearError()
                  }}
                />
              </div>
            )}
            <footer className="flex h-14 shrink-0 items-center gap-2 border-t border-gray-200 bg-gray-50/70 px-5">
              {selected && (
                <button
                  className={btn('dangerGhost', 'md')}
                  disabled={connecting}
                  onClick={() => void handleDelete()}
                >
                  <Trash2 size={14} strokeWidth={STROKE} />
                  {t('common.delete')}
                </button>
              )}
              <div className="flex-1" />
              {connecting ? (
                <>
                  <span className="flex min-w-0 items-center gap-2 truncate text-xs text-gray-500">
                    <Spinner />
                    {t('connect.connectingTo', { name: serverLabel(draft) })}
                  </span>
                  <button className={btn('secondary', 'md')} onClick={cancel}>
                    {t('common.cancel')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    className={btn('secondary', 'md')}
                    disabled={!dirty || !draft.host.trim()}
                    onClick={() => void handleSave()}
                  >
                    {t('servers.save')}
                  </button>
                  <button
                    className={btn('primary', 'md', 'min-w-[72px]')}
                    disabled={!draft.host.trim()}
                    onClick={() => void handleConnect()}
                  >
                    {t('connect.connect')}
                  </button>
                </>
              )}
            </footer>
          </section>
        </div>
      </div>
    </div>
  )
}
