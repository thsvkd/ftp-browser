import { RefreshCw, Settings, Unplug } from 'lucide-react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { reloadActiveTab } from '@renderer/lib/sendItems'
import { ConnectBar } from '@renderer/components/server/ConnectBar'
import { STROKE, btn } from '@renderer/components/server/styles'
import { ActivityPill } from '@renderer/components/activity/ActivityPill'
import { useT } from '@renderer/i18n'

interface ToolbarProps {
  onSettingsClick: () => void
}

export function Toolbar({ onSettingsClick }: ToolbarProps): React.JSX.Element {
  const connectionStatus = useFtpStore((s) => s.connectionStatus)
  const disconnect = useFtpStore((s) => s.disconnect)
  const connecting = useServerStore((s) => s.connecting)
  const cancel = useServerStore((s) => s.cancel)
  const t = useT()

  const isConnected = connectionStatus === 'connected'

  return (
    <div className="relative z-30 flex h-[52px] shrink-0 items-center gap-2 border-b border-[var(--bd)] bg-[var(--sf)] px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <ConnectBar />
        {/* 활성 탭(로컬이든 원격이든)을 다시 읽는다. F5·Ctrl+R도 창 어디서나 같다. */}
        <button
          onClick={reloadActiveTab}
          className={btn('secondary', 'md')}
          title={t('toolbar.refreshTooltip')}
        >
          <RefreshCw size={14} strokeWidth={STROKE} />
          {t('toolbar.refresh')}
        </button>
      </div>

      <ActivityPill />

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
          className={btn(
            'secondary',
            'md',
            'border-[var(--dg)]/30 text-[var(--dg)] hover:bg-[var(--dgw)]'
          )}
        >
          <Unplug size={14} strokeWidth={STROKE} />
          {t('connect.disconnect')}
        </button>
      )}

      {connecting && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-[var(--acw)]">
          <div className="h-full w-1/3 bg-[var(--ac)] motion-safe:animate-indeterminate" />
        </div>
      )}
    </div>
  )
}
