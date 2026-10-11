import { CircleAlert, LoaderCircle, Lock, Server as ServerIcon, X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useT } from '@renderer/i18n'
import { STROKE, dotTone } from './styles'

export function ServerDot({ label }: { label: string }): React.JSX.Element {
  return <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', dotTone(label))} />
}

export function ServerAvatar({ size }: { size: number }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-md bg-[var(--sb)] text-[var(--mu)] ring-1 ring-inset ring-[var(--bd)]"
      style={{ width: size, height: size }}
    >
      <ServerIcon size={Math.round(size * 0.5)} strokeWidth={STROKE} />
    </span>
  )
}

export function TlsBadge(): React.JSX.Element {
  const t = useT()
  return (
    <span
      title={t('servers.tlsBadge')}
      className="inline-flex shrink-0 items-center gap-0.5 rounded bg-[color-mix(in_srgb,var(--ok)_12%,transparent)] px-1 py-px text-[10px] font-semibold tracking-wide text-[var(--ok)] ring-1 ring-inset ring-[var(--ok)]"
    >
      <Lock size={9} strokeWidth={2.5} />
      TLS
    </span>
  )
}

export function Spinner({ size = 14 }: { size?: number }): React.JSX.Element {
  return <LoaderCircle size={size} className="shrink-0 animate-spin" aria-hidden />
}

export function ErrorNote({
  message,
  onClose,
  className
}: {
  message: string
  onClose?: () => void
  className?: string
}): React.JSX.Element {
  const t = useT()
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-md bg-[var(--dgw)] px-2.5 py-2 text-xs leading-relaxed text-[var(--dg)] ring-1 ring-inset ring-[var(--dg)] motion-safe:animate-drop',
        className
      )}
    >
      <CircleAlert size={14} className="mt-px shrink-0" />
      <span className="min-w-0 flex-1 select-text break-words">{message}</span>
      {onClose && (
        <button
          onClick={onClose}
          aria-label={t('connect.dismissError')}
          title={t('connect.dismissError')}
          className="-m-0.5 rounded p-0.5 text-[var(--dg)] hover:bg-[var(--dgw)] hover:text-[var(--dg)]"
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}
