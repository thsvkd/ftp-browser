import { useId, useState, type ReactNode } from 'react'
import { Eye, EyeOff, Folder } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useT } from '@renderer/i18n'
import {
  draftFields,
  isValidPort,
  parseServerAddress,
  type ServerDraft
} from '@renderer/lib/serverAddress'
import type { RecentPath } from '@shared/types/ftp'
import { STROKE, inputCls } from './styles'

export function PasswordInput({
  value,
  onChange,
  id,
  disabled,
  placeholder,
  className,
  inputClassName
}: {
  value: string
  onChange: (value: string) => void
  id?: string
  disabled?: boolean
  placeholder?: string
  className?: string
  inputClassName?: string
}): React.JSX.Element {
  const [show, setShow] = useState(false)
  const t = useT()
  return (
    <div className={cn('relative min-w-0', className)}>
      <input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        disabled={disabled}
        autoComplete="off"
        placeholder={placeholder}
        aria-label={id ? undefined : t('connect.password')}
        className={cn(inputCls, 'pr-8', inputClassName)}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow((s) => !s)}
        aria-label={show ? t('connect.hidePassword') : t('connect.showPassword')}
        title={show ? t('connect.hidePassword') : t('connect.showPassword')}
        className="absolute inset-y-0 right-0 grid w-8 place-items-center text-gray-400 hover:text-gray-700"
      >
        {show ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  )
}

/** Host field. A pasted address (or one typed and left) is split into the other fields. */
function HostInput({
  id,
  value,
  onPatch,
  disabled,
  autoFocus
}: {
  id: string
  value: string
  onPatch: (fields: Partial<ServerDraft>) => void
  disabled?: boolean
  autoFocus?: boolean
}): React.JSX.Element {
  const t = useT()
  const apply = (text: string): boolean => {
    if (!text.trim()) return false
    const parsed = parseServerAddress(text)
    // 호스트 하나뿐이면 나눌 게 없다. 그대로 두어야 'NAS.local' 같은 저장된 표기가 소문자로 바뀌지 않는다.
    if (Object.keys(parsed).length === 1) return false
    onPatch(draftFields(parsed))
    return true
  }
  return (
    <input
      id={id}
      value={value}
      disabled={disabled}
      autoFocus={autoFocus}
      spellCheck={false}
      autoComplete="off"
      placeholder={t('connect.hostPlaceholder')}
      className={inputCls}
      onChange={(e) => onPatch({ host: e.target.value })}
      onPaste={(e) => {
        if (apply(e.clipboardData.getData('text'))) e.preventDefault()
      }}
      onBlur={() => apply(value)}
    />
  )
}

function Switch({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: ReactNode
  disabled?: boolean
}): React.JSX.Element {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-2 text-[13px] text-gray-700">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-[18px] w-8 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600/40',
          checked ? 'bg-blue-600' : 'bg-gray-300'
        )}
      >
        <span
          className={cn(
            'absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-[left]',
            checked ? 'left-[16px]' : 'left-[2px]'
          )}
        />
      </button>
      {label}
    </label>
  )
}

/** Start folder chips from the server's recent paths. */
function PathChips({
  paths,
  value,
  onPick,
  disabled
}: {
  paths: RecentPath[]
  value: string
  onPick: (path: string) => void
  disabled?: boolean
}): React.JSX.Element | null {
  const list = paths.filter((p) => p.path !== '/')
  if (!list.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {['/', ...list.map((p) => p.path)].map((path) => {
        const on = value === path
        return (
          <button
            key={path}
            type="button"
            disabled={disabled}
            onClick={() => onPick(path)}
            aria-pressed={on}
            title={path}
            className={cn(
              'inline-flex h-6 max-w-full items-center gap-1 rounded-full px-2 text-[11.5px] ring-1 ring-inset transition-colors',
              on
                ? 'bg-blue-600/10 text-blue-700 ring-blue-600/35'
                : 'bg-white text-gray-600 ring-gray-200 hover:bg-gray-50 hover:ring-gray-300'
            )}
          >
            <Folder size={11} strokeWidth={STROKE} className="shrink-0" />
            <span className="truncate">{path}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Alias, address, login, FTPS and start folder of one server. */
export function ServerForm({
  draft,
  onPatch,
  recent = [],
  disabled,
  autoFocusHost
}: {
  draft: ServerDraft
  onPatch: (fields: Partial<ServerDraft>) => void
  recent?: RecentPath[]
  disabled?: boolean
  autoFocusHost?: boolean
}): React.JSX.Element {
  const id = useId()
  const t = useT()
  const portInvalid = draft.port.trim() !== '' && !isValidPort(Number(draft.port))
  const row = (label: ReactNode, forId: string, node: ReactNode): React.JSX.Element => (
    <div className="min-w-0">
      <label htmlFor={forId} className="mb-1 block text-xs font-medium text-gray-600">
        {label}
      </label>
      {node}
    </div>
  )

  return (
    <div className="flex flex-col gap-[14px]">
      {row(
        <>
          {t('connect.name')}{' '}
          <span className="font-normal text-gray-400">{t('common.optional')}</span>
        </>,
        `${id}-alias`,
        <input
          id={`${id}-alias`}
          value={draft.name}
          disabled={disabled}
          placeholder={t('connect.namePlaceholder')}
          className={inputCls}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
      )}
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          {row(
            t('connect.host'),
            `${id}-host`,
            <HostInput
              id={`${id}-host`}
              value={draft.host}
              disabled={disabled}
              autoFocus={autoFocusHost}
              onPatch={onPatch}
            />
          )}
        </div>
        <span className="pb-[7px] text-gray-400">:</span>
        <div className="w-[72px] shrink-0">
          {row(
            t('connect.port'),
            `${id}-port`,
            <input
              id={`${id}-port`}
              value={draft.port}
              disabled={disabled}
              inputMode="numeric"
              maxLength={5}
              placeholder="21"
              aria-invalid={portInvalid}
              title={portInvalid ? t('servers.invalidPort') : undefined}
              className={cn(
                inputCls,
                'tabular-nums',
                portInvalid && 'border-red-400 focus:border-red-500 focus:ring-red-500/20'
              )}
              onChange={(e) => onPatch({ port: e.target.value.replace(/\D/g, '') })}
            />
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-[14px]">
        {row(
          t('connect.username'),
          `${id}-user`,
          <input
            id={`${id}-user`}
            value={draft.username}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
            placeholder="anonymous"
            className={inputCls}
            onChange={(e) => onPatch({ username: e.target.value })}
          />
        )}
        {row(
          t('connect.password'),
          `${id}-pw`,
          <PasswordInput
            id={`${id}-pw`}
            value={draft.password}
            disabled={disabled}
            onChange={(password) => onPatch({ password })}
          />
        )}
      </div>
      <Switch
        checked={draft.secure}
        disabled={disabled}
        onChange={(secure) => onPatch({ secure })}
        label={
          <span>
            {t('connect.secure')}
            <span className="ml-1.5 text-xs text-gray-400">{t('connect.secureHint')}</span>
          </span>
        }
      />
      {row(
        t('connect.startFolder'),
        `${id}-path`,
        <div className="flex flex-col gap-1.5">
          <input
            id={`${id}-path`}
            value={draft.path}
            disabled={disabled}
            spellCheck={false}
            placeholder={t('connect.startFolderLast')}
            className={cn(inputCls, 'font-mono text-[12px]')}
            onChange={(e) => onPatch({ path: e.target.value })}
          />
          <PathChips
            paths={recent}
            value={draft.path}
            disabled={disabled}
            onPick={(path) => onPatch({ path })}
          />
        </div>
      )}
    </div>
  )
}
