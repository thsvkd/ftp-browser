export const IPC_CHANNELS = {
  // FTP
  FTP_CONNECT: 'ftp:connect',
  FTP_DISCONNECT: 'ftp:disconnect',
  FTP_LIST: 'ftp:list',
  FTP_GET_STATUS: 'ftp:getStatus',

  // FTP events (main -> renderer)
  FTP_CONNECTION_STATUS: 'ftp:connectionStatus'
} as const

export type IpcResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string }
