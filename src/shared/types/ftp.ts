export interface FtpServer {
  id?: number
  /** User-chosen alias; '' when unset (the UI then shows the host). */
  name: string
  host: string
  port: number
  username: string
  password: string
  secure: boolean
  lastConnected?: string
}

export interface RecentPath {
  path: string
  lastVisited: string
}

export interface FtpConnectPayload {
  /**
   * The saved server this connect uses with its saved account. Only then does a successful
   * connect update that server's alias and login; otherwise it just marks it connected.
   */
  id?: number
  /** Alias saved with the server on a successful connect. */
  name?: string
  host: string
  port: number
  user: string
  password: string
  secure: boolean
}

export interface FtpFileEntry {
  name: string
  type: 'file' | 'directory' | 'symbolic-link'
  size: number
  modifiedAt: string
  rawModifiedAt: string
  permissions?: string
  isImage: boolean
}

export interface FtpListResult {
  path: string
  entries: FtpFileEntry[]
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface FtpConnectionState {
  status: ConnectionStatus
  host?: string
  error?: string
}
