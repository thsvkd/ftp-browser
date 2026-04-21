import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const INVOKE_CHANNELS = [
  // FTP
  'ftp:connect',
  'ftp:disconnect',
  'ftp:list',
  'ftp:getStatus',
  'ftp:getLastServer',
  'ftp:getRecentServers',
  'ftp:deleteServer',
  'ftp:getRecentPaths',
  'ftp:downloadPreview',
  'ftp:delete',
  'ftp:rename',
  'ftp:mkdir',
  // Local FS
  'local:list',
  'local:getHome',
  'local:selectDirectory',
  'local:selectSaveDirectory',
  'local:copyFiles',
  // Transfer
  'transfer:enqueue',
  'transfer:cancel',
  'transfer:clearCompleted',
  'transfer:getAll',
  // Thumbnail
  'thumbnail:request',
  'thumbnail:requestBatch',
  'thumbnail:cancelAll',
  // Cache
  'cache:getStats',
  'cache:clear',
  // Drag
  'drag:start'
] as const

const EVENT_CHANNELS = [
  'ftp:connectionStatus',
  'transfer:updated',
  'transfer:progress',
  'thumbnail:ready',
  'thumbnail:error'
] as const

type InvokeChannel = (typeof INVOKE_CHANNELS)[number]
type EventChannel = (typeof EVENT_CHANNELS)[number]

const invokeSet = new Set<string>(INVOKE_CHANNELS)
const eventSet = new Set<string>(EVENT_CHANNELS)

const api = {
  invoke: <T>(channel: InvokeChannel, ...args: unknown[]): Promise<T> => {
    if (!invokeSet.has(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args) as Promise<T>
  },
  on: (channel: EventChannel, callback: (...args: unknown[]) => void): (() => void) => {
    if (!eventSet.has(channel)) {
      throw new Error(`IPC event channel not allowed: ${channel}`)
    }
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
      callback(...args)
    }
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
