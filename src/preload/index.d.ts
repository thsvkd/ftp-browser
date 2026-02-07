import { ElectronAPI } from '@electron-toolkit/preload'

type InvokeChannel =
  | 'ftp:connect'
  | 'ftp:disconnect'
  | 'ftp:list'
  | 'ftp:getStatus'
  | 'ftp:getLastServer'
  | 'ftp:getRecentServers'
  | 'ftp:getRecentPaths'
  | 'ftp:deleteServer'
  | 'ftp:downloadPreview'
  | 'ftp:delete'
  | 'ftp:rename'
  | 'ftp:mkdir'
  | 'local:list'
  | 'local:getHome'
  | 'local:selectDirectory'
  | 'local:selectSaveDirectory'
  | 'transfer:enqueue'
  | 'transfer:cancel'
  | 'transfer:clearCompleted'
  | 'transfer:getAll'
  | 'thumbnail:request'
  | 'thumbnail:requestBatch'
  | 'thumbnail:cancelAll'
  | 'cache:getStats'
  | 'cache:clear'
  | 'drag:start'

type EventChannel =
  | 'ftp:connectionStatus'
  | 'transfer:updated'
  | 'transfer:progress'
  | 'thumbnail:ready'
  | 'thumbnail:error'

interface FtpBrowserAPI {
  invoke: <T>(channel: InvokeChannel, ...args: unknown[]) => Promise<T>
  on: (channel: EventChannel, callback: (...args: unknown[]) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: FtpBrowserAPI
  }
}
