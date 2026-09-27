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
      className="grid shrink-0 place-items-center rounded-md bg-gray-100 text-gray-500 ring-1 ring-inset ring-gray-200/70"
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
      className="inline-flex shrink-0 items-center gap-0.5 rounded bg-emerald-50 px-1 py-px text-[10px] font-semibold tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-200"
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
        'flex items-start gap-2 rounded-md bg-red-50 px-2.5 py-2 text-xs leading-relaxed text-red-700 ring-1 ring-inset ring-red-200 motion-safe:animate-drop',
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
          className="-m-0.5 rounded p-0.5 text-red-400 hover:bg-red-100 hover:text-red-700"
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}
