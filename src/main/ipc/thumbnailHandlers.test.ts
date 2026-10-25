import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import Database from 'better-sqlite3'

// 핸들러는 등록만 기록하고 테스트가 꺼내 부른다. 썸네일 캐시 디렉터리는 임시 폴더를 쓴다.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => os.tmpdir()) },
  BrowserWindow: class {}
}))

import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { registerThumbnailHandlers } from './thumbnailHandlers'
import { FtpSessionRegistry } from '../ftp/FtpSessionRegistry'
import { generateCacheKey } from '../utils/cacheKey'
import { MAX_IMAGE_SIZE_BYTES } from '@shared/constants'
import type { ThumbnailRequest } from '../thumbnail/ThumbnailQueue'
import type { FtpConnectPayload } from '@shared/types/ftp'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import type { IpcResult } from '@shared/types/ipc'

type Handler = (event: unknown, req: ThumbnailRequest, server?: string) => IpcResult<string>

const MTIME = '2024-05-01T10:20:30.000Z'

const A_LOGIN: FtpConnectPayload = {
  host: 'example.org',
  port: 21,
  user: 'alice',
  password: 'x',
  secure: false
}
const B_LOGIN: FtpConnectPayload = { ...A_LOGIN, host: 'b.example.org', user: 'bob' }

/** 세션 하나의 가짜 매니저. 캐시 키에 들어가는 host·port만 다르면 된다. */
function fakeSession(host: string): FtpConnectionManager {
  return Object.assign(new EventEmitter(), {
    getHost: () => host,
    getPort: () => 21
  }) as unknown as FtpConnectionManager
}

describe('thumbnailHandlers', () => {
  let tmpDir: string
  let handlers: Map<string, Handler>
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-ipc-test-'))
    vi.mocked(app.getPath).mockImplementation(() => tmpDir)
    handlers = new Map()
    vi.mocked(ipcMain.handle).mockImplementation(((channel: string, listener: Handler) => {
      handlers.set(channel, listener)
    }) as unknown as typeof ipcMain.handle)
    db = new Database(':memory:')
    db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations/001_initial.sql'), 'utf-8'))

    // primary인 A와 별도 세션 B를 put해 둔다. 캐시 키는 요청 세션의 host·port로 만들어야 한다(함정 A).
    const registry = new FtpSessionRegistry()
    registry.put(B_LOGIN, fakeSession('b.example.org'))
    registry.put(A_LOGIN, fakeSession('example.org'))
    registerThumbnailHandlers(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow,
      db,
      registry
    )
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function request(req: ThumbnailRequest, server?: string): IpcResult<string> {
    const handler = handlers.get('thumbnail:request')
    if (!handler) throw new Error('No handler registered for "thumbnail:request"')
    return handler({}, req, server)
  }

  it('builds the thumbnail cache key from the requested session host and port', async () => {
    // covers: Test-911
    // 상한을 넘는 요청이라 다운로드 없이 캐시 키만 돌려준다.
    const req: ThumbnailRequest = {
      remotePath: '/photos/pic.jpg',
      fileName: 'pic.jpg',
      fileSize: MAX_IMAGE_SIZE_BYTES + 1,
      modifiedAt: MTIME,
      priority: 0
    }

    const viaOther = request(req, 'bob@b.example.org:21')
    expect(viaOther).toEqual({
      success: true,
      data: generateCacheKey('b.example.org', 21, req.remotePath, req.fileSize, req.modifiedAt)
    })

    // 인자를 생략하면 primary(A): 같은 요청도 세션에 따라 키가 갈린다.
    const viaPrimary = request(req)
    expect(viaPrimary).toEqual({
      success: true,
      data: generateCacheKey('example.org', 21, req.remotePath, req.fileSize, req.modifiedAt)
    })
  })
})
