import { RefreshCw, Settings, Unplug } from 'lucide-react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { ConnectBar } from '@renderer/components/server/ConnectBar'
import { STROKE, btn } from '@renderer/components/server/styles'
import { useT } from '@renderer/i18n'

interface ToolbarProps {
  onSettingsClick: () => void
}

export function Toolbar({ onSettingsClick }: ToolbarProps): React.JSX.Element {
  const connectionStatus = useFtpStore((s) => s.connectionStatus)
  const disconnect = useFtpStore((s) => s.disconnect)
  const refresh = useFtpStore((s) => s.refresh)
  const connecting = useServerStore((s) => s.connecting)
  const cancel = useServerStore((s) => s.cancel)
  const t = useT()

  const isConnected = connectionStatus === 'connected'

  return (
    <div className="relative z-30 flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <ConnectBar />
        {isConnected && (
          <button
            onClick={refresh}
            className={btn('secondary', 'md')}
            title={t('toolbar.refreshTooltip')}
          >
            <RefreshCw size={14} strokeWidth={STROKE} />
            {t('toolbar.refresh')}
          </button>
        )}
      </div>

      <button
        onClick={onSettingsClick}
        className={btn('ghost', 'icon')}
        title={t('settings.title')}
        aria-label={t('settings.title')}
      >
        <Settings size={15} strokeWidth={STROKE} />
      </button>

      {isConnected && (
        <button
          // 시작 폴더를 읽는 동안에도 연결됨으로 보인다. 그때 끊는 건 연결 취소다(실패로 보이지 않게).
          onClick={connecting ? cancel : disconnect}
          className={btn('secondary', 'md', 'border-red-200 text-red-600 hover:bg-red-50')}
        >
          <Unplug size={14} strokeWidth={STROKE} />
          {t('connect.disconnect')}
        </button>
      )}

      {connecting && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-blue-600/10">
          <div className="h-full w-1/3 bg-blue-600 motion-safe:animate-indeterminate" />
        </div>
      )}
    </div>
  )
}
