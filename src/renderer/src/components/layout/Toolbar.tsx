import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Settings,
  Unplug
} from 'lucide-react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useLayoutStore } from '@renderer/stores/useLayoutStore'
import { formatPaneShortcut, type PaneSide } from '@renderer/lib/sidebarLayout'
import { currentPlatform } from '@renderer/lib/platform'
import { reloadActiveTab } from '@renderer/lib/sendItems'
import { ConnectBar } from '@renderer/components/server/ConnectBar'
import { STROKE, btn } from '@renderer/components/server/styles'
import { ActivityPill } from '@renderer/components/activity/ActivityPill'
import { useT } from '@renderer/i18n'

const TOGGLE_ICONS = {
  left: { open: PanelLeftClose, closed: PanelLeftOpen },
  right: { open: PanelRightClose, closed: PanelRightOpen }
}

/** 사이드 패널 토글. 툴바는 창 전체 폭이라 패널이 접혀도 자리가 변하지 않는다(D9). */
function PaneToggle({ side }: { side: PaneSide }): React.JSX.Element {
  const t = useT()
  const collapsed = useLayoutStore((s) => s[side].collapsed)
  const toggle = useLayoutStore((s) => s.toggle)
  const Icon = TOGGLE_ICONS[side][collapsed ? 'closed' : 'open']
  const shortcut = formatPaneShortcut(side, currentPlatform())
  return (
    <button
      onClick={() => toggle(side)}
      className={btn('ghost', 'icon')}
      aria-label={t(side === 'left' ? 'panes.toggleLeft' : 'panes.toggleRight')}
      aria-expanded={!collapsed}
      aria-controls={side === 'left' ? 'sidebar-pane' : 'rail-pane'}
      title={t(side === 'left' ? 'panes.toggleLeftTooltip' : 'panes.toggleRightTooltip', {
        shortcut
      })}
    >
      <Icon size={15} strokeWidth={STROKE} />
    </button>
  )
}

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
      <PaneToggle side="left" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* 위치가 지정된 조상이 툴바 루트뿐이라 툴바 아래 가장자리를 가로지른다. 토글이 양 끝 자식이어야 해서 여기 둔다. */}
        {connecting && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-[var(--acw)]">
            <div className="h-full w-1/3 bg-[var(--ac)] motion-safe:animate-indeterminate" />
          </div>
        )}
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

      <PaneToggle side="right" />
    </div>
  )
}
