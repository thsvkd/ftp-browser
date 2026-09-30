/** Simultaneous transfer connections per server. 1 = one at a time; 20 is the cap the setting allows. */
export const DEFAULT_MAX_TRANSFERS = 16
export const MIN_MAX_TRANSFERS = 1
export const MAX_MAX_TRANSFERS = 20

export const isValidMaxTransfers = (n: number): boolean =>
  Number.isInteger(n) && n >= MIN_MAX_TRANSFERS && n <= MAX_MAX_TRANSFERS

/** `n` when it is a valid setting, else the default (a missing or out-of-range payload value). */
export const normalizeMaxTransfers = (n: number | undefined): number =>
  n !== undefined && isValidMaxTransfers(n) ? n : DEFAULT_MAX_TRANSFERS

export interface FtpServer {
  id?: number
  /** User-chosen alias; '' when unset (the UI then shows the host). */
  name: string
  host: string
  port: number
  username: string
  password: string
  secure: boolean
  /** Simultaneous transfer connections; the app lowers it by itself if the server refuses. */
  maxTransfers?: number
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
  /** Simultaneous transfer connections. Omitted (quick connect): DEFAULT_MAX_TRANSFERS. */
  maxTransfers?: number
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
