import { RefreshCw, Settings, ChevronDown } from 'lucide-react'
import { useFtpStore } from '@renderer/stores/useFtpStore'

interface ToolbarProps {
  onConnectClick: () => void
  onSettingsClick: () => void
}

export function Toolbar({ onConnectClick, onSettingsClick }: ToolbarProps): React.JSX.Element {
  const connectionStatus = useFtpStore((s) => s.connectionStatus)
  const host = useFtpStore((s) => s.host)
  const disconnect = useFtpStore((s) => s.disconnect)
  const refresh = useFtpStore((s) => s.refresh)

  const isConnected = connectionStatus === 'connected'

  return (
    <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-3 py-2">
      {!isConnected ? (
        <button
          onClick={onConnectClick}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          Connect
        </button>
      ) : (
        <>
          <button
            onClick={onConnectClick}
            className="group flex items-center gap-2 rounded-md border border-transparent px-2 py-1 hover:border-gray-300 hover:bg-gray-50"
            title="Switch server"
          >
            <span className="h-2 w-2 rounded-full bg-green-500" />
            <span className="text-sm text-gray-700">{host}</span>
            <ChevronDown size={14} className="text-gray-400 group-hover:text-gray-600" />
          </button>
          <button
            onClick={refresh}
            className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            title="Refresh (F5)"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </>
      )}

      <div className="flex-1" />

      <button
        onClick={onSettingsClick}
        className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        title="Settings"
        aria-label="Settings"
      >
        <Settings size={14} />
      </button>

      {isConnected && (
        <button
          onClick={disconnect}
          className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
        >
          Disconnect
        </button>
      )}
    </div>
  )
}
