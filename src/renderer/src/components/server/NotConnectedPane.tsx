import { cn } from '@renderer/lib/utils'
import { useT } from '@renderer/i18n'
import { useServerStore } from '@renderer/stores/useServerStore'
import { serverAddress, serverLabel, toDraft } from '@renderer/lib/serverAddress'
import type { FtpServer } from '@shared/types/ftp'
import { ServerDot } from './serverUi'

/**
 * Chip text: the alias, or `host:port` when there is none — several unaliased servers often share
 * one IP (a phone running FTP on different ports), and the bare host would make them identical.
 */
const chipLabel = (s: FtpServer): string =>
  s.name || serverAddress({ username: '', host: s.host, port: s.port })

/** Remote pane before connecting: a hint and the recent servers as chips. */
export function NotConnectedPane(): React.JSX.Element {
  const servers = useServerStore((s) => s.servers)
  const currentId = useServerStore((s) => s.draft.id)
  const connecting = useServerStore((s) => s.connecting)
  const { select, connect } = useServerStore.getState()
  const t = useT()

  return (
    <div className="grid flex-1 place-items-center p-8 text-center">
      <div className="max-w-[380px]">
        <p className="text-sm font-medium text-gray-700">{t('explorer.notConnected')}</p>
        <p className="mt-1 text-xs leading-relaxed text-gray-400">
          {t('explorer.notConnectedHint')}
          <br />
          <code className="mt-1 inline-block select-text rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-500">
            ftp://user@192.168.0.10:2121/DCIM
          </code>
        </p>
        {servers.length > 0 && (
          <div className="mt-6">
            <div className="mb-2 text-[11px] font-medium text-gray-400">
              {t('connect.recentServers')}
            </div>
            <div className="flex flex-wrap justify-center gap-1.5">
              {servers.slice(0, 5).map((s) => (
                <button
                  key={s.id}
                  // 연결 중에는 툴바의 서버를 바꾸지 않는다.
                  disabled={connecting}
                  onClick={() => select(s)}
                  onDoubleClick={() => void connect(toDraft(s))}
                  title={t('connect.chipTooltip', { address: serverAddress(s) })}
                  className={cn(
                    'inline-flex h-7 max-w-full items-center gap-1.5 rounded-full px-3 text-xs ring-1 ring-inset transition-colors disabled:opacity-50',
                    s.id === currentId
                      ? 'bg-blue-600/10 text-gray-900 ring-blue-600/40'
                      : 'bg-white text-gray-600 ring-gray-200 hover:bg-gray-50'
                  )}
                >
                  <ServerDot label={serverLabel(s)} />
                  <span className="truncate">{chipLabel(s)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
