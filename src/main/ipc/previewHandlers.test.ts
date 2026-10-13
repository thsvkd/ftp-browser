import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Writable } from 'stream'
import Database from 'better-sqlite3'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
let tempRoot = ''

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  },
  app: { getPath: () => tempRoot }
}))

import { registerPreviewHandlers } from './previewHandlers'
import { ConnectionRegistry } from '../ftp/ConnectionRegistry'
import { fakeSession, payloadOf, remoteOf } from '../ftp/__fixtures__/fakeSessions'
import { generateCacheKey } from '../utils/cacheKey'
import type { IpcResult } from '@shared/types/ipc'

// 같은 호스트·포트의 두 사용자: 같은 경로라도 홈(chroot)이 달라 다른 파일이다.
const A = 'u1@nas.local:21'
const B = 'u2@nas.local:21'
const REQ = { remotePath: '/photos/a.jpg', fileSize: 3, modifiedAt: '2024-05-01T00:00:00.000Z' }

describe('ftp:downloadPreview', () => {
  let db: Database.Database
  let registry: ConnectionRegistry
  const secondary = new Map<string, ReturnType<typeof vi.fn>>()

  beforeEach(async () => {
    handlers.clear()
    tempRoot = mkdtempSync(join(tmpdir(), 'preview-test-'))
    // initDatabase가 만드는 preview_cache와 같은 테이블
    db = new Database(':memory:')
    db.exec(`CREATE TABLE preview_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_key TEXT NOT NULL UNIQUE,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    registry = new ConnectionRegistry((key) => {
      const session = fakeSession(key)
      // 각 연결의 보조 클라이언트는 그 연결의 사용자 이름을 내용으로 내려 준다
      const create = vi.fn(async () => ({
        downloadTo: vi.fn(async (out: Writable) => {
          out.write(Buffer.from(key.slice(0, 2)))
        }),
        close: vi.fn()
      }))
      secondary.set(key, create)
      Object.assign(remoteOf(session), { createSecondaryClient: create })
      return session
    })
    await registry.connect(payloadOf(A))
    await registry.connect(payloadOf(B))
    registerPreviewHandlers(db, registry)
  })

  afterEach(() => {
    db.close()
    rmSync(tempRoot, { recursive: true, force: true })
  })

  const preview = async (conn: string): Promise<IpcResult<string>> =>
    (await handlers.get('ftp:downloadPreview')!({}, conn, REQ)) as IpcResult<string>

  it('downloads through that connection and caches under its key, not another user’s row', async () => {
    // covers: Test-973
    expect(await preview(A)).toEqual({
      success: true,
      data: `data:image/jpeg;base64,${Buffer.from('u1').toString('base64')}`
    })
    expect(secondary.get(A)).toHaveBeenCalledTimes(1)

    // A가 같은 경로로 캐시해 둔 행을 B가 쓰지 않는다
    expect(await preview(B)).toEqual({
      success: true,
      data: `data:image/jpeg;base64,${Buffer.from('u2').toString('base64')}`
    })
    expect(secondary.get(B)).toHaveBeenCalledTimes(1)
    expect(secondary.get(A)).toHaveBeenCalledTimes(1)

    const keys = (
      db.prepare('SELECT cache_key FROM preview_cache').all() as { cache_key: string }[]
    )
      .map((r) => r.cache_key)
      .sort()
    expect(keys).toEqual(
      [A, B].map((conn) => generateCacheKey(conn, REQ.remotePath, REQ.fileSize, REQ.modifiedAt))
    )
  })
})
