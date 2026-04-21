export const IPC_CHANNELS = {
  // FTP
  FTP_CONNECT: 'ftp:connect',
  FTP_DISCONNECT: 'ftp:disconnect',
  FTP_LIST: 'ftp:list',
  FTP_GET_STATUS: 'ftp:getStatus',

  // FTP events (main -> renderer)
  FTP_CONNECTION_STATUS: 'ftp:connectionStatus'
} as const

/** 에러 코드 — renderer에서 에러 종류에 따라 UI를 분기할 때 사용 */
export const ErrorCode = {
  // Network
  NETWORK_UNREACHABLE: 'NETWORK_UNREACHABLE',
  CONNECTION_REFUSED: 'CONNECTION_REFUSED',
  CONNECTION_TIMEOUT: 'CONNECTION_TIMEOUT',
  CONNECTION_RESET: 'CONNECTION_RESET',
  DNS_NOT_FOUND: 'DNS_NOT_FOUND',

  // FTP
  FTP_AUTH_FAILED: 'FTP_AUTH_FAILED',
  FTP_PERMISSION_DENIED: 'FTP_PERMISSION_DENIED',
  FTP_NOT_FOUND: 'FTP_NOT_FOUND',
  FTP_NOT_CONNECTED: 'FTP_NOT_CONNECTED',
  FTP_TRANSFER_FAILED: 'FTP_TRANSFER_FAILED',
  FTP_SERVER_ERROR: 'FTP_SERVER_ERROR',

  // Local FS
  FS_PERMISSION_DENIED: 'FS_PERMISSION_DENIED',
  FS_NOT_FOUND: 'FS_NOT_FOUND',
  FS_DISK_FULL: 'FS_DISK_FULL',
  FS_ALREADY_EXISTS: 'FS_ALREADY_EXISTS',

  // General
  UNKNOWN: 'UNKNOWN'
} as const

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode]

export type IpcResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: ErrorCodeType }
