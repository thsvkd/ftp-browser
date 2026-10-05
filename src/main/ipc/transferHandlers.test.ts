import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  },
  BrowserWindow: class {}
}))

import { registerTransferHandlers } from './transferHandlers'
import type { BrowserWindow } from 'electron'
import type { FtpFileOperations } from '../ftp/FtpFileOperations'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'

describe('registerTransferHandlers', () => {
  let manager: EventEmitter
  let client: { closed: boolean; close: () => void; sendIgnoringError: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.useFakeTimers()
    handlers.clear()
    client = {
      closed: false,
      close: vi.fn(),
      sendIgnoringError: vi.fn().mockResolvedValue({ code: 257, message: '257 created' })
    }
    manager = Object.assign(new EventEmitter(), {
      createSecondaryClient: vi.fn().mockResolvedValue(client),
      getMaxTransfers: vi.fn(() => 16)
    })
    const fileOps = {
      upload: vi.fn().mockResolvedValue(undefined),
      download: vi.fn().mockResolvedValue(undefined)
    }
    registerTransferHandlers(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow,
      fileOps as unknown as FtpFileOperations,
      manager as unknown as FtpConnectionManager
    )
  })

  it('passes remoteDirs to the queue and announces each created dir as a mkdir mutation', async () => {
    const mutations: unknown[] = []
    manager.on('mutation', (event) => mutations.push(event))

    const enqueue = handlers.get('transfer:enqueueBatch')!
    const result = enqueue(
      {},
      {
        direction: 'upload',
        items: [
          { localPath: '/l/a', remotePath: '/t/d/a', fileName: 'a', totalBytes: 1 },
          { localPath: '/l/b', remotePath: '/t/d/b', fileName: 'b', totalBytes: 1 }
        ],
        forceBatch: true,
        remoteDirs: ['/t/d']
      }
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(result).toMatchObject({ success: true })
    expect(client.sendIgnoringError).toHaveBeenCalledWith('MKD /t/d')
    expect(mutations).toEqual([{ kind: 'mkdir', remotePath: '/t/d' }])
  })
})
