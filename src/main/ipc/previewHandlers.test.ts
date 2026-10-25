import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'

// previewHandlers는 electron의 ipcMain을, 프리뷰 캐시는 app.getPath('userData')를 쓴다.
// node 환경에서 모듈이 로드되도록 목으로 세운다. handle은 등록만 기록하고, 테스트가 그
// 핸들러를 꺼내 직접 호출한다. 캐시 폴더는 임시 디렉터리로 잡아 afterEach에서 지운다.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => os.tmpdir()) }
}))

import { app, ipcMain } from 'electron'
import { EventEmitter } from 'events'
import { registerPreviewHandlers } from './previewHandlers'
import { FtpSessionRegistry } from '../ftp/FtpSessionRegistry'
import { PreviewCacheManager } from '../preview/PreviewCacheManager'
import { generateCacheKey } from '../utils/cacheKey'
import { MAX_IMAGE_SIZE_BYTES, MAX_VIDEO_SIZE_BYTES } from '@shared/constants'
import type { FtpConnectPayload } from '@shared/types/ftp'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import type { IpcResult } from '@shared/types/ipc'

interface PreviewRequest {
  remotePath: string
  fileSize: number
  modifiedAt: string
}

type Handler = (event: unknown, req: PreviewRequest, server?: string) => Promise<IpcResult<string>>

const MTIME = '2024-05-01T10:20:30.000Z'

const A_LOGIN: FtpConnectPayload = {
  host: 'example.org',
  port: 21,
  user: 'alice',
  password: 'x',
  secure: false
}
const B_LOGIN: FtpConnectPayload = { ...A_LOGIN, host: 'b.example.org', user: 'bob' }

/** 세션 하나의 가짜 매니저. 호스트·포트와 보조 클라이언트를 세션마다 구분해 관찰한다. */
function fakeSession(
  host: string,
  downloadTo: (writable: NodeJS.WritableStream) => Promise<void>
): { manager: FtpConnectionManager; createSecondaryClient: ReturnType<typeof vi.fn> } {
  const createSecondaryClient = vi.fn(async () => ({ downloadTo, close: vi.fn() }))
  const manager = Object.assign(new EventEmitter(), {
    getHost: () => host,
    getPort: () => 21,
    createSecondaryClient,
    runOnMainClient: vi.fn()
  }) as unknown as FtpConnectionManager
  return { manager, createSecondaryClient }
}

describe('previewHandlers', () => {
  let tmpDir: string
  let handlers: Map<string, Handler>
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-ipc-test-'))
    vi.mocked(app.getPath).mockImplementation(() => tmpDir)
    handlers = new Map()
    vi.mocked(ipcMain.handle).mockImplementation(((channel: string, listener: Handler) => {
      handlers.set(channel, listener)
    }) as unknown as typeof ipcMain.handle)
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE preview_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cache_key TEXT NOT NULL UNIQUE,
        file_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** 보조 클라이언트에 `bytes`를 물려두고 핸들러를 등록한다(A = primary, B = 아래에put된 다른 세션). */
  function setup(bytes: Buffer): {
    preview: (req: PreviewRequest, server?: string) => Promise<IpcResult<string>>
    /** primary(A)의 보조 클라이언트 호출 수 */
    createSecondaryClient: ReturnType<typeof vi.fn>
    /** B 세션의 보조 클라이언트 호출 수 */
    otherSessionClient: ReturnType<typeof vi.fn>
  } {
    const downloadTo = async (writable: NodeJS.WritableStream): Promise<void> => {
      await new Promise<void>((resolve) => writable.end(bytes, resolve))
    }
    const a = fakeSession('example.org', downloadTo)
    const b = fakeSession('b.example.org', downloadTo)
    const registry = new FtpSessionRegistry()
    registry.put(B_LOGIN, b.manager)
    registry.put(A_LOGIN, a.manager) // primary = A
    registerPreviewHandlers(db, registry)
    const preview = async (req: PreviewRequest, server?: string): Promise<IpcResult<string>> => {
      const handler = handlers.get('ftp:downloadPreview')
      if (!handler) throw new Error('No handler registered for "ftp:downloadPreview"')
      return handler(null, req, server)
    }
    return {
      preview,
      createSecondaryClient: a.createSecondaryClient,
      otherSessionClient: b.createSecondaryClient
    }
  }

  it('returns a webm preview as a data:video/webm URL through the secondary client', async () => {
    // covers: Test-875
    const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 9, 8])
    const { preview, createSecondaryClient } = setup(bytes)

    const result = await preview({
      remotePath: '/videos/clip.webm',
      fileSize: 1024,
      modifiedAt: MTIME
    })

    expect(result).toEqual({
      success: true,
      data: `data:video/webm;base64,${bytes.toString('base64')}`
    })
    expect(createSecondaryClient).toHaveBeenCalledTimes(1)
  })

  it('keeps gif previews as data:image/gif URLs', async () => {
    // covers: Test-876
    const bytes = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    const { preview } = setup(bytes)

    const result = await preview({
      remotePath: '/photos/anim.gif',
      fileSize: 2048,
      modifiedAt: MTIME
    })

    expect(result).toEqual({
      success: true,
      data: `data:image/gif;base64,${bytes.toString('base64')}`
    })
  })

  it('caps videos at MAX_VIDEO_SIZE_BYTES and keeps the 50MB image cap', async () => {
    // covers: Test-877
    const { preview, createSecondaryClient } = setup(Buffer.from('not really a video'))

    // 이미지 상한(50MB)을 넘지만 영상 상한(100MB) 안이다. 두 상한을 하나로 합치면 거부된다.
    const midVideo = await preview({
      remotePath: '/videos/clip.mp4',
      fileSize: MAX_IMAGE_SIZE_BYTES + 1,
      modifiedAt: MTIME
    })
    expect(midVideo).toMatchObject({
      success: true,
      data: expect.stringContaining('data:video/mp4;base64,')
    })

    await expect(
      preview({
        remotePath: '/videos/clip.webm',
        fileSize: MAX_VIDEO_SIZE_BYTES + 1,
        modifiedAt: MTIME
      })
    ).resolves.toEqual({ success: false, error: 'File too large for preview' })
    await expect(
      preview({
        remotePath: '/photos/big.jpg',
        fileSize: MAX_IMAGE_SIZE_BYTES + 1,
        modifiedAt: MTIME
      })
    ).resolves.toEqual({ success: false, error: 'File too large for preview' })
    // 거부는 다운로드 전에 이뤄진다.
    expect(createSecondaryClient).toHaveBeenCalledTimes(1)
  })

  it('builds the preview cache key from the requested session host and port', async () => {
    // covers: Test-910
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const { preview, createSecondaryClient, otherSessionClient } = setup(bytes)
    const req: PreviewRequest = {
      remotePath: '/photos/pic.png',
      fileSize: 1024,
      modifiedAt: MTIME
    }
    // B 세션의 host·port로 만든 키만 캐시에 채워 둔다. primary(A)의 키로 찾으면 미적중이다.
    const keyOfB = generateCacheKey(
      'b.example.org',
      21,
      req.remotePath,
      req.fileSize,
      req.modifiedAt
    )
    new PreviewCacheManager(db).store(keyOfB, 'image/png', bytes)

    const result = await preview(req, 'bob@b.example.org:21')

    expect(result).toEqual({
      success: true,
      data: `data:image/png;base64,${bytes.toString('base64')}`
    })
    // 캐시에 적중했으므로 어느 세션도 다운로드하지 않는다(primary의 키로 찾았다면 A가 다운로드한다).
    expect(createSecondaryClient).not.toHaveBeenCalled()
    expect(otherSessionClient).not.toHaveBeenCalled()
  })
})
