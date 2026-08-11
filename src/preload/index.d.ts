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
  | 'ftp:deleteBatch'
  | 'ftp:rename'
  | 'ftp:mkdir'
  | 'local:list'
  | 'local:getHome'
  | 'local:selectDirectory'
  | 'local:selectSaveDirectory'
  | 'local:expandForUpload'
  | 'local:copyFiles'
  | 'local:deleteBatch'
  | 'local:rename'
  | 'local:mkdir'
  | 'transfer:enqueue'
  | 'transfer:cancel'
  | 'transfer:clearCompleted'
  | 'transfer:getAll'
  | 'operation:cancel'
  | 'operation:clearFinished'
  | 'operation:getAll'
  | 'thumbnail:request'
  | 'thumbnail:requestBatch'
  | 'thumbnail:cancelAll'
  | 'cache:getStats'
  | 'cache:clear'
  | 'drag:start'
  | 'gallery:remoteFolderPreview'
  | 'gallery:localFolderPreview'
  | 'gallery:cancelAll'
  | 'localThumbnail:request'
  | 'localThumbnail:clear'

type EventChannel =
  | 'ftp:connectionStatus'
  | 'transfer:updated'
  | 'transfer:progress'
  | 'operation:updated'
  | 'operation:progress'
  | 'thumbnail:ready'
  | 'thumbnail:error'
  | 'localThumbnail:ready'
  | 'localThumbnail:error'

interface FtpBrowserAPI {
  invoke: <T>(channel: InvokeChannel, ...args: unknown[]) => Promise<T>
  on: (channel: EventChannel, callback: (...args: unknown[]) => void) => () => void
  getPathForFile: (file: File) => string
  debugToolsEnabled: boolean
  platform: string
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: FtpBrowserAPI
  }
}
