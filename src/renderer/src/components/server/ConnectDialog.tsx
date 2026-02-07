import { useState, useEffect } from 'react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import type { FtpServer, RecentPath } from '@shared/types/ftp'
import type { IpcResult } from '@shared/types/ipc'

interface ConnectDialogProps {
  open: boolean
  onClose: () => void
}

export function ConnectDialog({ open, onClose }: ConnectDialogProps): React.JSX.Element | null {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('21')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [secure, setSecure] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')
  const [initialPath, setInitialPath] = useState('/')

  const [recentServers, setRecentServers] = useState<FtpServer[]>([])
  const [recentPaths, setRecentPaths] = useState<RecentPath[]>([])
  const [selectedServerId, setSelectedServerId] = useState<number | null>(null)

  const connect = useFtpStore((s) => s.connect)

  useEffect(() => {
    if (!open) return
    // Fetch recent servers
    window.api
      .invoke<IpcResult<FtpServer[]>>('ftp:getRecentServers')
      .then((result) => {
        if (result.success && result.data.length > 0) {
          setRecentServers(result.data)
          // Auto-select most recent server
          const first = result.data[0]
          selectServer(first)
        }
      })
      .catch(() => {})
  }, [open])

  if (!open) return null

  const selectServer = (server: FtpServer): void => {
    setHost(server.host)
    setPort(String(server.port))
    setUser(server.username)
    setPassword(server.password)
    setSecure(server.secure)
    setSelectedServerId(server.id ?? null)
    setInitialPath('/')
    setError('')

    // Fetch recent paths for this server
    window.api
      .invoke<IpcResult<RecentPath[]>>('ftp:getRecentPaths', server.host, server.port)
      .then((result) => {
        if (result.success) {
          setRecentPaths(result.data)
        }
      })
      .catch(() => {})
  }

  const handleDeleteServer = async (e: React.MouseEvent, serverId: number): Promise<void> => {
    e.stopPropagation()
    await window.api.invoke('ftp:deleteServer', serverId)
    setRecentServers((prev) => prev.filter((s) => s.id !== serverId))
    if (selectedServerId === serverId) {
      setSelectedServerId(null)
      setRecentPaths([])
    }
  }

  const handleConnect = async (): Promise<void> => {
    setConnecting(true)
    setError('')
    let cleanHost = host.trim()
    let parsedPort = parseInt(port) || 21
    cleanHost = cleanHost.replace(/^(ftps?|sftp):\/\//i, '')
    const colonIdx = cleanHost.lastIndexOf(':')
    if (colonIdx > 0) {
      const maybePort = parseInt(cleanHost.slice(colonIdx + 1))
      if (!isNaN(maybePort) && maybePort > 0 && maybePort <= 65535) {
        parsedPort = maybePort
        cleanHost = cleanHost.slice(0, colonIdx)
      }
    }
    cleanHost = cleanHost.replace(/\/+$/, '')
    const success = await connect(
      {
        host: cleanHost,
        port: parsedPort,
        user: user || 'anonymous',
        password: password || 'anonymous@',
        secure
      },
      initialPath
    )
    setConnecting(false)
    if (success) {
      onClose()
    } else {
      const ftpError = useFtpStore.getState().error
      setError(ftpError || 'Connection failed. Check your credentials and try again.')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !connecting) {
      handleConnect()
    }
    if (e.key === 'Escape') {
      onClose()
    }
  }

  const formatDate = (dateStr?: string): string => {
    if (!dateStr) return ''
    try {
      const d = new Date(dateStr)
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    } catch {
      return dateStr
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="w-[520px] rounded-lg bg-white p-6 shadow-xl"
        onKeyDown={handleKeyDown}
      >
        <h2 className="mb-4 text-lg font-semibold">FTP Server Connection</h2>

        {/* Recent servers */}
        {recentServers.length > 0 && (
          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-medium text-gray-500">Recent Servers</label>
            <div className="max-h-32 overflow-y-auto rounded-md border border-gray-200">
              {recentServers.map((server) => (
                <div
                  key={server.id}
                  className={`flex cursor-pointer items-center justify-between px-3 py-2 text-sm hover:bg-blue-50 ${
                    selectedServerId === server.id ? 'bg-blue-50' : ''
                  }`}
                  onClick={() => selectServer(server)}
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">
                      {server.host}:{server.port}
                    </span>
                    <span className="ml-2 text-gray-400">
                      {server.username || 'anonymous'}
                    </span>
                    {server.secure && (
                      <span className="ml-1.5 rounded bg-green-100 px-1 text-xs text-green-700">
                        TLS
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">
                      {formatDate(server.lastConnected)}
                    </span>
                    <button
                      className="rounded p-0.5 text-gray-400 hover:bg-red-100 hover:text-red-600"
                      onClick={(e) => handleDeleteServer(e, server.id!)}
                      title="Remove from history"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent paths for selected server */}
        {recentPaths.length > 0 && (
          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-medium text-gray-500">
              Recent Paths
            </label>
            <div className="max-h-24 overflow-y-auto rounded-md border border-gray-200">
              {recentPaths.map((rp) => (
                <div
                  key={rp.path}
                  className={`cursor-pointer px-3 py-1.5 text-sm hover:bg-blue-50 ${
                    initialPath === rp.path ? 'bg-blue-50 font-medium' : ''
                  }`}
                  onClick={() => setInitialPath(rp.path)}
                >
                  <span className="text-gray-700">{rp.path}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-3">
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-sm font-medium text-gray-700">Host</label>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="ftp.example.com"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                autoFocus
              />
            </div>
            <div className="w-20">
              <label className="mb-1 block text-sm font-medium text-gray-700">Port</label>
              <input
                type="text"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-sm font-medium text-gray-700">Username</label>
              <input
                type="text"
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="anonymous"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-sm font-medium text-gray-700">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="********"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={secure}
              onChange={(e) => setSecure(e.target.checked)}
              className="rounded"
            />
            Use FTPS (TLS)
          </label>

          {error && (
            <p className="rounded bg-red-50 p-2 text-sm text-red-600">{error}</p>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConnect}
            disabled={!host || connecting}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {connecting ? 'Connecting...' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}
