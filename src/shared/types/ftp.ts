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
  /**
   * Whether a password is saved for this server. The password itself never leaves the main
   * process: it is stored encrypted and read only to log in (docs/handoff/saved-password-encryption.md).
   */
  hasPassword: boolean
  secure: boolean
  /** Simultaneous transfer connections; the app lowers it by itself if the server refuses. */
  maxTransfers?: number
  lastConnected?: string
}

/** What the renderer sends to save a server. */
export interface FtpServerInput extends Omit<FtpServer, 'hasPassword' | 'lastConnected'> {
  /**
   * `undefined` keeps the password saved for `id` (none for a new server), `''` removes it, any
   * other value replaces it.
   */
  password?: string
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
  /** The password typed for this login. Omitted when {@link savedPasswordOf} supplies it. */
  password?: string
  /**
   * Log in with the password saved for this server id instead of a typed one; main reads it
   * itself, so the renderer never holds it. A successful connect then keeps the saved password.
   */
  savedPasswordOf?: number
  secure: boolean
  /** Simultaneous transfer connections. Omitted (quick connect): DEFAULT_MAX_TRANSFERS. */
  maxTransfers?: number
}

/** How well saved passwords are protected on this computer (main → renderer). */
export interface PasswordProtection {
  /**
   * 'keyring': encrypted with a key the OS keeps (Keychain, DPAPI, Secret Service/KWallet).
   * 'basic': encrypted with a fixed key because Linux has no secret store (`basic_text`): this
   * only hides passwords from casual reading. 'none': encryption is unavailable, so passwords are
   * stored as plain text.
   */
  level: 'keyring' | 'basic' | 'none'
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

/**
 * 원격 측 상태를 변경한 작업의 알림. 폴더 미리보기 등 캐시 무효화 hook이 구독한다.
 * `download`처럼 read-only 작업은 emit하지 않는다. main은 렌더러에 `ftp:remoteChanged`로도 보낸다.
 */
export interface FtpMutationEvent {
  kind: 'delete' | 'rename' | 'mkdir' | 'upload'
  remotePath: string
  newPath?: string
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface FtpConnectionState {
  status: ConnectionStatus
  host?: string
  error?: string
}
