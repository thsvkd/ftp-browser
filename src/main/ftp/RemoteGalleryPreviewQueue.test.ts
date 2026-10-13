import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FileInfo } from 'basic-ftp'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))

import { RemoteGalleryPreviewQueue } from './RemoteGalleryPreviewQueue'
import { ConnectionRegistry } from './ConnectionRegistry'
import { fakeSession, payloadOf } from './__fixtures__/fakeSessions'
import { registerGalleryHandlers } from '../ipc/galleryHandlers'
import type { FtpConnectionManager } from './FtpConnectionManager'
import type { RemoteFolderPreviewCache } from './RemoteFolderPreviewCache'
import type { RemoteFolderPreview } from '@shared/types/gallery'
import type { BrowserWindow } from 'electron'

const CONN = 'me@nas.local:21'

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

function image(name: string): FileInfo {
  return {
    name,
    isDirectory: false,
    isSymbolicLink: false,
    size: 5,
    modifiedAt: new Date('2024-05-01T00:00:00.000Z')
  } as FileInfo
}

/** 폴더 LIST가 테스트가 `list`로 끝낼 때까지 기다리는 가짜 보조 클라이언트를 주는 큐 */
function createHarness(): {
  queue: RemoteGalleryPreviewQueue
  listing: string[]
  list: (path: string) => Promise<void>
  counts: { created: number; closed: number }
} {
  const listing: string[] = []
  const pending = new Map<string, () => void>()
  const counts = { created: 0, closed: 0 }
  const manager = {
    getConnKey: () => CONN,
    createSecondaryClient: vi.fn(async () => {
      counts.created++
      const failures = new Set<(err: Error) => void>()
      return {
        list: (path: string) =>
          new Promise<FileInfo[]>((resolve, reject) => {
            listing.push(path)
            failures.add(reject)
            pending.set(path, () => resolve([image(`${path.slice(1)}.jpg`)]))
          }),
        // 진행 중 LIST는 실제 basic-ftp처럼 닫히면 에러로 끝난다
        close: () => {
          counts.closed++
          for (const fail of failures) fail(new Error('Client is closed'))
        }
      }
    })
  } as unknown as FtpConnectionManager
  const cache = {
    lookup: vi.fn(() => undefined),
    store: vi.fn()
  } as unknown as RemoteFolderPreviewCache
  return {
    queue: new RemoteGalleryPreviewQueue(manager, cache),
    listing,
    list: async (path: string) => {
      pending.get(path)?.()
      await flush()
    },
    counts
  }
}

function previewOf(path: string): RemoteFolderPreview {
  return {
    name: `${path.slice(1)}.jpg`,
    size: 5,
    modifiedAt: '2024-05-01T00:00:00.000Z',
    itemCount: 1
  }
}

describe('RemoteGalleryPreviewQueue — pending items are owned by viewers', () => {
  it('keeps a folder both viewers wait for when one cancels, and rejects what only the canceller waited for', async () => {
    // covers: Test-998
    const h = createHarness()
    // 동시 2개 슬롯을 left의 두 폴더로 채운다.
    const first = h.queue.request('/a', 'left')
    const second = h.queue.request('/b', 'left')
    await flush()
    expect(h.listing).toEqual(['/a', '/b'])

    const shared = h.queue.request('/p', 'left')
    const sharedByRight = h.queue.request('/p', 'right')
    const leftOnly = h.queue.request('/q', 'left')
    const leftOnlyResult = leftOnly.then(
      () => 'resolved',
      (err: Error) => err.message
    )

    h.queue.cancelAll('left')
    expect(await leftOnlyResult).toBe('Cancelled')

    // right가 남아 있으므로 연결을 닫지 않고, 진행 중이던 폴더도 그대로 끝난다.
    expect(h.counts.closed).toBe(0)
    await h.list('/a')
    await h.list('/b')
    await expect(first).resolves.toEqual(previewOf('/a'))
    await expect(second).resolves.toEqual(previewOf('/b'))
    expect(h.listing).toEqual(['/a', '/b', '/p'])
    await h.list('/p')
    await expect(sharedByRight).resolves.toEqual(previewOf('/p'))
    await expect(shared).resolves.toEqual(previewOf('/p'))
  })

  it('closes its connections when no owner is left after the cancel', async () => {
    // covers: Test-998
    const h = createHarness()
    const waiting = h.queue.request('/a', 'left')
    const waitingResult = waiting.then(
      () => 'resolved',
      (err: Error) => err.message
    )
    h.queue.request('/b', 'left').catch(() => undefined)
    const queued = h.queue.request('/c', 'left')
    const queuedResult = queued.then(
      () => 'resolved',
      (err: Error) => err.message
    )
    await flush()
    expect(h.counts.created).toBe(2)

    h.queue.cancelAll('left')
    await flush()

    expect(await queuedResult).toBe('Cancelled')
    expect(await waitingResult).not.toBe('resolved')
    expect(h.counts.closed).toBeGreaterThanOrEqual(2)
  })
})

describe('gallery:remoteFolderPreview — routed by connection', () => {
  beforeEach(() => handlers.clear())

  it('sends a request and a cancel to the named session’s queue only', async () => {
    // covers: Test-998
    const A = 'a@host:21'
    const B = 'b@host:21'
    const gallery = (): {
      request: ReturnType<typeof vi.fn>
      cancelAll: ReturnType<typeof vi.fn>
    } => ({
      request: vi.fn(async () => null),
      cancelAll: vi.fn()
    })
    const queues = { [A]: gallery(), [B]: gallery() }
    const registry = new ConnectionRegistry((key) =>
      fakeSession(key, { gallery: queues[key] as unknown as RemoteGalleryPreviewQueue })
    )
    await registry.connect(payloadOf(A))
    await registry.connect(payloadOf(B))
    registerGalleryHandlers({} as BrowserWindow, registry, {} as RemoteFolderPreviewCache)

    const request = handlers.get('gallery:remoteFolderPreview')!
    const cancel = handlers.get('gallery:cancelAll')!
    await request({}, B, { remotePath: '/x', viewerId: 'right' })
    expect(queues[B].request).toHaveBeenCalledWith('/x', 'right')
    expect(queues[A].request).not.toHaveBeenCalled()

    cancel({}, A, 'left')
    expect(queues[A].cancelAll).toHaveBeenCalledWith('left')
    expect(queues[B].cancelAll).not.toHaveBeenCalled()

    cancel({}, null, 'right')
    expect(queues[A].cancelAll).toHaveBeenLastCalledWith('right')
    expect(queues[B].cancelAll).toHaveBeenLastCalledWith('right')
  })

  it('refuses a missing viewer id', async () => {
    // covers: Test-998
    const registry = new ConnectionRegistry((key) => fakeSession(key))
    registerGalleryHandlers({} as BrowserWindow, registry, {} as RemoteFolderPreviewCache)
    expect(handlers.get('gallery:cancelAll')!({}, null, '')).toEqual({
      success: false,
      error: 'Invalid viewer id.'
    })
  })
})
