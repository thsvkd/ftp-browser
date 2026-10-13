import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))

import { registerThumbnailHandlers } from './thumbnailHandlers'
import { ConnectionRegistry } from '../ftp/ConnectionRegistry'
import { fakeSession, payloadOf } from '../ftp/__fixtures__/fakeSessions'
import { ThumbnailQueue, type ThumbnailRequest } from '../thumbnail/ThumbnailQueue'
import { generateCacheKey } from '../utils/cacheKey'
import { MAX_IMAGE_SIZE_BYTES } from '@shared/constants'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import type { CacheManager } from '../thumbnail/CacheManager'
import type { ThumbnailGenerator } from '../thumbnail/ThumbnailGenerator'

const A = 'a@host:21'
const B = 'b@host:21'
const REQS: ThumbnailRequest[] = [
  { remotePath: '/x.jpg', fileName: 'x.jpg', fileSize: 10, modifiedAt: 't', priority: 0 }
]

interface Spy {
  request: ReturnType<typeof vi.fn>
  requestBatch: ReturnType<typeof vi.fn>
  cancelAll: ReturnType<typeof vi.fn>
}

async function setup(): Promise<{ spies: Record<string, Spy>; registry: ConnectionRegistry }> {
  handlers.clear()
  const spies: Record<string, Spy> = {}
  const registry = new ConnectionRegistry((key) => {
    spies[key] = {
      request: vi.fn(() => `${key}:key`),
      requestBatch: vi.fn(() => [`${key}:key`]),
      cancelAll: vi.fn()
    }
    return fakeSession(key, { thumbs: spies[key] as unknown as ThumbnailQueue })
  })
  await registry.connect(payloadOf(A))
  await registry.connect(payloadOf(B))
  registerThumbnailHandlers(registry, {} as CacheManager)
  return { spies, registry }
}

describe('thumbnail channels — routed by connection and viewer', () => {
  beforeEach(() => handlers.clear())

  it('sends a batch to the named session’s queue only, with the viewer id', async () => {
    // covers: Test-997
    const { spies } = await setup()

    const result = await handlers.get('thumbnail:requestBatch')!({}, B, 'left', REQS)

    expect(result).toEqual({ success: true, data: [`${B}:key`] })
    expect(spies[B].requestBatch).toHaveBeenCalledWith('left', REQS)
    expect(spies[A].requestBatch).not.toHaveBeenCalled()
  })

  it('cancels one session’s viewer, or that viewer on every session for a null connection', async () => {
    // covers: Test-997
    const { spies } = await setup()

    handlers.get('thumbnail:cancelAll')!({}, A, 'left')
    expect(spies[A].cancelAll).toHaveBeenCalledWith('left')
    expect(spies[B].cancelAll).not.toHaveBeenCalled()

    handlers.get('thumbnail:cancelAll')!({}, null, 'right')
    expect(spies[A].cancelAll).toHaveBeenLastCalledWith('right')
    expect(spies[B].cancelAll).toHaveBeenCalledTimes(1)
    expect(spies[B].cancelAll).toHaveBeenCalledWith('right')
  })

  it('returns a cache key built from the named connection for a single request', async () => {
    // covers: Test-997
    handlers.clear()
    const registry = new ConnectionRegistry((key) => {
      const session = fakeSession(key)
      const thumbs = new ThumbnailQueue(
        session.manager as unknown as FtpConnectionManager,
        {} as ThumbnailGenerator,
        { lookup: vi.fn(() => undefined) } as unknown as CacheManager,
        vi.fn(),
        vi.fn()
      )
      return { ...session, thumbs }
    })
    await registry.connect(payloadOf(A))
    await registry.connect(payloadOf(B))
    registerThumbnailHandlers(registry, {} as CacheManager)
    // 큰 파일은 큐에 들어가지 않고 키만 돌려받는다(다운로드를 시작하지 않는다)
    const req = { ...REQS[0], fileSize: MAX_IMAGE_SIZE_BYTES + 1 }

    const result = await handlers.get('thumbnail:request')!({}, B, req)

    expect(result).toEqual({
      success: true,
      data: generateCacheKey(B, req.remotePath, req.fileSize, req.modifiedAt)
    })
    expect(result).not.toEqual({
      success: true,
      data: generateCacheKey(A, req.remotePath, req.fileSize, req.modifiedAt)
    })
  })

  it('refuses a missing viewer id and an unconnected connection', async () => {
    // covers: Test-997
    const { spies } = await setup()

    expect(handlers.get('thumbnail:requestBatch')!({}, A, '', REQS)).toEqual({
      success: false,
      error: 'Invalid viewer id.'
    })
    expect(handlers.get('thumbnail:cancelAll')!({}, null, undefined)).toEqual({
      success: false,
      error: 'Invalid viewer id.'
    })
    expect(spies[A].requestBatch).not.toHaveBeenCalled()
    expect(spies[A].cancelAll).not.toHaveBeenCalled()
    expect(handlers.get('thumbnail:requestBatch')!({}, 'c@host:21', 'left', REQS)).toMatchObject({
      success: false,
      error: 'Not connected to c@host:21.'
    })
  })
})
