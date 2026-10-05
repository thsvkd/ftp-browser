import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { Writable } from 'stream'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import type { CacheManager } from '../thumbnail/CacheManager'
import type { ThumbnailGenerator } from '../thumbnail/ThumbnailGenerator'
import { createThumbnailPreviewer } from './thumbnailPreviews'
import type { PreviewRequest } from './mcpTools'

/**
 * 보조 FTP 연결 가짜. 열린 연결 수와 동시 다운로드 수의 최댓값을 센다.
 * `hold`가 켜져 있으면 다운로드가 `release()`까지 멈추고, close는 진행 중 다운로드를 실패시킨다.
 */
function fakeFtp(): {
  ftp: FtpConnectionManager
  stats: { created: number; open: number; maxOpen: number; active: number; maxActive: number }
  hold: { on: boolean; release: () => void }
} {
  const stats = { created: 0, open: 0, maxOpen: 0, active: 0, maxActive: 0 }
  const waiting: Array<() => void> = []
  const hold = {
    on: false,
    release: () => waiting.splice(0).forEach((resume) => resume())
  }
  const emitter = new EventEmitter()
  const ftp = Object.assign(emitter, {
    getHost: () => 'ftp.example.com',
    getPort: () => 21,
    runOnMainClient: vi.fn(),
    createSecondaryClient: vi.fn(async () => {
      stats.created++
      stats.open++
      stats.maxOpen = Math.max(stats.maxOpen, stats.open)
      let closed = false
      let abort: ((err: Error) => void) | undefined
      return {
        downloadTo: async (writable: Writable) => {
          stats.active++
          stats.maxActive = Math.max(stats.maxActive, stats.active)
          try {
            await new Promise<void>((resolve, reject) => {
              abort = reject
              if (hold.on) waiting.push(resolve)
              else setImmediate(resolve)
            })
            writable.write(Buffer.from('raw'))
          } finally {
            stats.active--
          }
        },
        close: () => {
          if (closed) return
          closed = true
          stats.open--
          abort?.(new Error('Client is closed'))
        }
      }
    })
  })
  return { ftp: ftp as unknown as FtpConnectionManager, stats, hold }
}

const generator = {
  getFormat: async () => 'jpeg',
  generate: async () => ({ buffer: Buffer.from('jpeg'), width: 4, height: 3 })
} as unknown as ThumbnailGenerator

const cache = {
  lookup: () => null,
  readThumbnail: () => Buffer.alloc(0),
  store: vi.fn()
} as unknown as CacheManager

function images(prefix: string, count: number): PreviewRequest[] {
  return Array.from({ length: count }, (_, i) => ({
    remotePath: `/${prefix}/${i}.jpg`,
    fileSize: 100,
    modifiedAt: '2026-01-01T00:00:00.000Z'
  }))
}

describe('MCP image previews', () => {
  it('uses one secondary connection at most, even for concurrent calls', async () => {
    // covers: Test-464
    const { ftp, stats } = fakeFtp()
    const previews = createThumbnailPreviewer(ftp, generator, cache)

    const [first, second] = await Promise.all([
      previews(images('a', 3)),
      previews([...images('b', 3), images('b', 1)[0]])
    ])

    expect(first.every((outcome) => outcome.ok)).toBe(true)
    expect(second.every((outcome) => outcome.ok)).toBe(true)
    expect(second).toHaveLength(4)
    expect(stats.maxOpen).toBe(1)
    expect(stats.maxActive).toBe(1)
    expect(stats.created).toBe(1)
    // 할 일이 없으면 보조 연결을 닫는다.
    expect(stats.open).toBe(0)
  })

  it('fails the waiting previews and drops the connection when the FTP connection changes', async () => {
    // covers: Test-474
    const { ftp, stats, hold } = fakeFtp()
    const previews = createThumbnailPreviewer(ftp, generator, cache)
    hold.on = true

    const running = previews(images('old', 2))
    const queued = previews(images('old2', 1))
    await vi.waitFor(() => expect(stats.active).toBe(1))
    ftp.emit('connectionStatus', { status: 'connecting', host: 'other.example.com' })

    for (const outcomes of [await running, await queued]) {
      for (const outcome of outcomes) {
        expect(outcome).toEqual({ ok: false, error: expect.stringMatching(/connection changed/i) })
      }
    }
    expect(stats.open).toBe(0)

    hold.on = false
    hold.release()
    const fresh = await previews(images('new', 1))
    expect(fresh).toEqual([{ ok: true, data: expect.any(String), width: 4, height: 3 }])
    expect(stats.created).toBe(2)
  })
})
