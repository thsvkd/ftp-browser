import { useRef, useState } from 'react'
import { Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useLocale, useT } from '@renderer/i18n'
import { useServerStore } from '@renderer/stores/useServerStore'
import {
  formatLastConnected,
  matchServer,
  serverAddress,
  serverLabel
} from '@renderer/lib/serverAddress'
import type { FtpServer } from '@shared/types/ftp'
import { ServerDot, TlsBadge } from './serverUi'
import { STROKE, arrowIndex, btn, inputCls, selectedCls } from './styles'

/** Saved servers dropdown under the toolbar address bar. */
export function SavedServersPopover({
  currentId,
  onPick,
  onEdit,
  onAdd,
  onClose
}: {
  currentId?: number
  /** Click selects; double-click and Enter pass `connect`. */
  onPick: (server: FtpServer, connect: boolean) => void
  onEdit: (server: FtpServer) => void
  onAdd: () => void
  onClose: () => void
}): React.JSX.Element {
  const servers = useServerStore((s) => s.servers)
  const remove = useServerStore((s) => s.remove)
  const t = useT()
  const locale = useLocale()
  const [query, setQuery] = useState('')
  const list = servers.filter((s) => matchServer(s, query))
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      list.findIndex((s) => s.id === currentId)
    )
  )
  const idx = Math.min(active, list.length - 1)
  const listRef = useRef<HTMLDivElement>(null)

  return (
    <div
      className="absolute left-0 top-[calc(100%+8px)] z-50 flex max-h-[460px] w-[400px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg bg-white shadow-xl ring-1 ring-black/10 motion-safe:animate-drop"
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        const next = arrowIndex(e.key, idx, list.length)
        if (next !== null && e.key.startsWith('Arrow')) {
          e.preventDefault()
          setActive(next)
          listRef.current?.querySelector(`[data-i="${next}"]`)?.scrollIntoView({ block: 'nearest' })
        } else if (e.key === 'Enter' && list[idx]) {
          e.preventDefault()
          onPick(list[idx], true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="relative border-b border-gray-100 p-2">
        <Search
          size={14}
          strokeWidth={STROKE}
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"
        />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          placeholder={t('servers.search')}
          aria-label={t('servers.search')}
          className={cn(inputCls, 'border-transparent bg-gray-100 pl-8 focus:bg-white')}
        />
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-label={t('connect.savedServers')}
        className="min-h-0 flex-1 overflow-y-auto p-1"
      >
        {list.map((s, i) => {
          const on = i === idx
          const label = serverLabel(s)
          return (
            <div
              key={s.id}
              data-i={i}
              role="option"
              aria-selected={on}
              onMouseMove={() => i !== idx && setActive(i)}
              onClick={() => onPick(s, false)}
              onDoubleClick={() => onPick(s, true)}
              className={cn(
                'group flex h-11 cursor-default items-center gap-2.5 rounded-md px-2.5',
                on && selectedCls
              )}
            >
              <ServerDot label={label} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium">{label}</span>
                  {s.secure && <TlsBadge />}
                  {s.id === currentId && (
                    <span className="shrink-0 text-[10.5px] text-blue-600">
                      {t('servers.current')}
                    </span>
                  )}
                </div>
                <div className="truncate text-[11px] text-gray-500">{serverAddress(s)}</div>
              </div>
              <span className={cn('flex items-center gap-0.5', !on && 'hidden')}>
                <button
                  tabIndex={-1}
                  className={btn('ghost', 'iconSm')}
                  aria-label={t('servers.editLabel', { name: label })}
                  title={t('servers.editLabel', { name: label })}
                  onClick={(e) => {
                    e.stopPropagation()
                    onEdit(s)
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <Pencil size={13} strokeWidth={STROKE} />
                </button>
                <button
                  tabIndex={-1}
                  className={btn('ghost', 'iconSm', 'hover:bg-red-50 hover:text-red-600')}
                  aria-label={t('servers.deleteLabel', { name: label })}
                  title={t('servers.deleteLabel', { name: label })}
                  onClick={(e) => {
                    e.stopPropagation()
                    void remove(s)
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <Trash2 size={13} strokeWidth={STROKE} />
                </button>
              </span>
              {!on && (
                <span className="shrink-0 text-[11px] text-gray-400">
                  {formatLastConnected(s.lastConnected, locale) ?? t('servers.neverConnected')}
                </span>
              )}
            </div>
          )
        })}
        {list.length === 0 && (
          <p className="px-3 py-5 text-center text-xs text-gray-400">
            {query ? t('servers.noMatch', { query }) : t('servers.empty')}
          </p>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-gray-100 bg-gray-50/70 px-2 py-1.5">
        <button className={btn('ghost', 'sm')} onClick={onAdd}>
          <Plus size={13} strokeWidth={STROKE} />
          {t('servers.add')}
        </button>
        <span className="pr-1 text-[10.5px] text-gray-400">{t('servers.hint')}</span>
      </div>
    </div>
  )
}
