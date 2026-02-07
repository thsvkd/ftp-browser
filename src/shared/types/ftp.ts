export interface FtpServer {
  id?: number
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
