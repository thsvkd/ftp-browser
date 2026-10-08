import { useEffect, useRef, useState } from 'react'
import { BookMarked, ChevronDown, Lock, LockOpen, Plug, SlidersHorizontal } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useT } from '@renderer/i18n'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import {
  emptyDraft,
  serverAddress,
  serverLabel,
  toDraft,
  type ServerDraft
} from '@renderer/lib/serverAddress'
import type { FtpServer } from '@shared/types/ftp'
import { PasswordInput } from './ServerForm'
import { SavedServersPopover } from './SavedServersPopover'
import { ServerManagerDialog } from './ServerManagerDialog'
import { ErrorNote, ServerDot } from './serverUi'
import { STROKE, btn, onEnterEsc } from './styles'

/** 주소창 안에 들어가는 입력칸: 테두리·링 없이 */
const BARE = 'h-full rounded-none border-0 focus:border-transparent focus:ring-0'

/** 툴바의 좁은 비밀번호 칸에 맞는, 언어와 상관없는 "저장된 비밀번호" 자리표시 */
const SAVED_PASSWORD_DOTS = '••••••••'

/**
 * Toolbar connect UI. Disconnected: saved-servers button, address, password, FTPS lock,
 * server manager and Connect. Connected: the current server, which switches servers.
 */
export function ConnectBar(): React.JSX.Element {
  const isConnected = useFtpStore((s) => s.connectionStatus === 'connected')
  const connectedHost = useFtpStore((s) => s.host)
  const draft = useServerStore((s) => s.draft)
  const address = useServerStore((s) => s.address)
  const connecting = useServerStore((s) => s.connecting)
  const error = useServerStore((s) => s.error)
  const saved = useServerStore((s) => s.servers.find((sv) => sv.id === s.draft.id))
  const { loadServers, select, setAddress, patch, clearError, connect, cancel } =
    useServerStore.getState()
  const t = useT()

  const [popover, setPopover] = useState(false)
  const [manager, setManager] = useState<ServerDraft | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // 시작할 때 마지막으로 연결한 서버를 채워 둔다.
  useEffect(() => {
    void loadServers(true)
  }, [loadServers])

  // 연결 중 Esc는 포커스가 어디 있든 연결을 취소한다.
  useEffect(() => {
    if (!connecting) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [connecting, cancel])

  // 드롭다운 바깥을 누르면 닫는다.
  useEffect(() => {
    if (!popover) return
    const onDown = (e: MouseEvent): void => {
      if (!barRef.current?.contains(e.target as Node)) setPopover(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [popover])

  /** 닫으면 포커스를 연 자리(연결됨: 서버 버튼, 아니면 주소창)로 돌려준다. */
  const closePopover = (): void => {
    setPopover(false)
    ;(isConnected ? triggerRef : addressRef).current?.focus()
  }

  // 연결 중 클릭은 스토어가 무시한다(select·connect가 아무것도 바꾸지 않음).
  const pick = (server: FtpServer, andConnect: boolean): void => {
    // 이미 연결된 서버를 다시 고르면 끊었다 잇지 않고 닫기만 한다.
    if (isConnected && server.id === draft.id) {
      closePopover()
      return
    }
    // 연결된 상태에서 고르면 그 서버로 전환한다.
    if (andConnect || isConnected) {
      setPopover(false)
      void connect(toDraft(server))
    } else {
      // 클릭은 주소창에 채우기만 하고 목록은 열어 둔다. 닫으면 이어지는 더블클릭이 갈 곳이 없다.
      select(server)
    }
  }

  const popoverEl = popover && (
    <SavedServersPopover
      currentId={draft.id}
      onPick={pick}
      onEdit={(server) => {
        setPopover(false)
        setManager(toDraft(server))
      }}
      onAdd={() => {
        setPopover(false)
        setManager(emptyDraft())
      }}
      onClose={() => {
        // 드롭다운이 Esc를 가로채므로 연결 중이면 여기서 취소한다.
        if (connecting) cancel()
        closePopover()
      }}
    />
  )
  const managerEl = manager && (
    <ServerManagerDialog
      initial={manager}
      onClose={() => setManager(null)}
      // 연 버튼이 사라졌으면(드롭다운의 편집, 연결 후 모드 전환) 지금 보이는 툴바 입력으로 돌아간다.
      returnFocus={() => (triggerRef.current ?? addressRef.current)?.focus()}
    />
  )

  // 대화상자는 연결 상태가 바뀌어도 다시 마운트되지 않도록 두 모드 밖에 둔다.
  if (isConnected) {
    return (
      <>
        {connectedBar()}
        {managerEl}
      </>
    )
  }
  return (
    <>
      {addressBar()}
      {managerEl}
    </>
  )

  function connectedBar(): React.JSX.Element {
    const label = serverLabel(draft) || connectedHost
    return (
      <div ref={barRef} className="relative flex min-w-0 items-center">
        <button
          ref={triggerRef}
          onClick={() => setPopover((p) => !p)}
          aria-haspopup="listbox"
          aria-expanded={popover}
          title={t('toolbar.switchServer')}
          className={cn(
            'group flex min-w-0 items-center gap-2 rounded-md px-2 py-1 hover:bg-gray-50',
            popover && 'bg-gray-50'
          )}
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" />
          <span className="truncate text-[13px] font-medium text-gray-900">{label}</span>
          {draft.host && (
            <span className="truncate text-xs text-gray-400">{serverAddress(draft)}</span>
          )}
          <ChevronDown size={14} className="shrink-0 text-gray-400" />
        </button>
        {popoverEl}
      </div>
    )
  }

  function addressBar(): React.JSX.Element {
    const hasUser = draft.username.trim() !== '' && !/^anonymous$/i.test(draft.username.trim())
    return (
      <div ref={barRef} className="relative flex min-w-0 items-center gap-2">
        <div
          className={cn(
            'flex h-8 w-[560px] min-w-0 items-stretch rounded-md border bg-white transition-shadow focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-600/20',
            error ? 'border-red-300' : 'border-gray-300'
          )}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'ArrowDown' && (e.target as HTMLElement).tagName === 'INPUT') {
              e.preventDefault()
              setPopover(true)
              return
            }
            onEnterEsc({
              enter: () => {
                if (!connecting && draft.host.trim()) void connect()
              },
              esc: () => (connecting ? cancel() : setPopover(false))
            })(e)
          }}
        >
          <button
            onClick={() => setPopover((p) => !p)}
            aria-haspopup="listbox"
            aria-expanded={popover}
            title={t('connect.savedServersTooltip')}
            className={cn(
              'flex max-w-[180px] shrink-0 items-center gap-1.5 rounded-l-md border-r border-gray-200 pl-2.5 pr-2 text-[12.5px] hover:bg-gray-50',
              popover && 'bg-gray-50'
            )}
          >
            {saved ? (
              <>
                <ServerDot label={serverLabel(saved)} />
                <span className="truncate font-medium text-gray-800">{serverLabel(saved)}</span>
              </>
            ) : (
              <>
                <BookMarked size={14} strokeWidth={STROKE} className="shrink-0 text-gray-500" />
                <span className="truncate text-gray-500">
                  {draft.host ? t('connect.newServer') : t('connect.savedServers')}
                </span>
              </>
            )}
            <ChevronDown size={13} className="shrink-0 text-gray-400" />
          </button>
          <input
            ref={addressRef}
            value={address}
            disabled={connecting}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setAddress(e.target.value)}
            placeholder={t('connect.addressPlaceholder')}
            aria-label={t('connect.address')}
            className="min-w-0 flex-1 bg-transparent px-2.5 font-mono text-[12.5px] text-gray-900 placeholder:font-sans placeholder:text-gray-400 focus:outline-none disabled:text-gray-500"
          />
          {hasUser && (
            <PasswordInput
              value={draft.password}
              disabled={connecting}
              // 저장된 비밀번호는 렌더러에 없다. 칸은 비워 둔다(E10). 칸이 좁아 자리표시는 언어와
              // 상관없는 점으로 두고, "저장된 비밀번호"는 이름·툴팁으로 알린다(E20).
              placeholder={draft.savedPassword ? SAVED_PASSWORD_DOTS : t('connect.password')}
              label={draft.savedPassword ? t('connect.savedPassword') : undefined}
              onChange={(password) => patch({ password })}
              className="w-[118px] border-l border-gray-200"
              inputClassName={cn(BARE, 'bg-transparent text-[12.5px]')}
            />
          )}
          <button
            onClick={() => patch({ secure: !draft.secure })}
            disabled={connecting}
            aria-pressed={draft.secure}
            title={draft.secure ? t('connect.secureOn') : t('connect.secureOff')}
            aria-label={t('connect.secure')}
            className={cn(
              'grid w-8 shrink-0 place-items-center border-l border-gray-200',
              draft.secure ? 'text-emerald-600' : 'text-gray-400 hover:text-gray-700'
            )}
          >
            {draft.secure ? (
              <Lock size={13} strokeWidth={STROKE} />
            ) : (
              <LockOpen size={13} strokeWidth={STROKE} />
            )}
          </button>
          <button
            onClick={() => {
              setPopover(false)
              setManager(draft)
            }}
            title={t('connect.serverManager')}
            aria-label={t('connect.serverManager')}
            className="grid w-8 shrink-0 place-items-center rounded-r-md border-l border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-800"
          >
            <SlidersHorizontal size={13} strokeWidth={STROKE} />
          </button>
        </div>

        {connecting ? (
          <button className={btn('secondary', 'md', 'min-w-[76px]')} onClick={cancel}>
            {t('common.cancel')}
          </button>
        ) : (
          <button
            className={btn('primary', 'md', 'min-w-[76px]')}
            disabled={!draft.host.trim()}
            onClick={() => {
              setPopover(false)
              void connect()
            }}
          >
            <Plug size={13} strokeWidth={STROKE} />
            {t('connect.connect')}
          </button>
        )}
        {connecting && !manager && (
          <span className="truncate text-xs text-gray-500">
            {t('connect.connectingTo', { name: serverLabel(draft) })}
          </span>
        )}

        {popoverEl}
        {error && !popover && !manager && (
          <div className="absolute left-0 top-[calc(100%+8px)] z-40 w-[440px] max-w-[calc(100vw-24px)]">
            <ErrorNote message={error} onClose={clearError} className="shadow-lg" />
          </div>
        )}
      </div>
    )
  }
}
