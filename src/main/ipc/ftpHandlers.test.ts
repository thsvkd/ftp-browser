import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

// 핸들러는 등록만 기록하고 테스트가 꺼내 부른다. FTP 연결은 가짜, DB는 실제 스키마의 메모리 DB다.
const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  db: undefined as unknown as import('better-sqlite3').Database,
  connect: undefined as unknown as import('vitest').Mock
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, fn)
  },
  BrowserWindow: class {},
  app: { getPath: () => '' }
}))

vi.mock('../db/database', () => ({ getDatabase: () => state.db }))

vi.mock('../ftp/FtpConnectionManager', async () => {
  const { EventEmitter } = await import('events')
  return {
    FtpConnectionManager: class extends EventEmitter {
      connect = state.connect
    }
  }
})

vi.mock('../ftp/FtpFileOperations', () => ({ FtpFileOperations: class {} }))

import type { BrowserWindow } from 'electron'
import { ErrorCode, type IpcResult } from '@shared/types/ipc'
import type { FtpServer, FtpServerInput } from '@shared/types/ftp'
import { registerFtpHandlers } from './ftpHandlers'
import { createPasswordVault } from '../db/passwordVault'
import { FakeCipher, fakeCipherOf } from '../db/__fixtures__/fakeCipher'
import type { OperationManager } from '../operation/OperationManager'

let cipher: FakeCipher

beforeEach(() => {
  state.handlers.clear()
  state.db = new Database(':memory:')
  const migrations = path.join(__dirname, '../db/migrations')
  for (const file of [
    '001_initial.sql',
    '002_server_max_transfers.sql',
    '003_server_password_cipher.sql'
  ]) {
    state.db.exec(fs.readFileSync(path.join(migrations, file), 'utf-8'))
  }
  state.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_host_port ON servers(host, port)')
  state.connect = vi.fn(async () => ({ success: true }))
  cipher = new FakeCipher({ backend: 'basic_text' })
  registerFtpHandlers(
    { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow,
    {} as OperationManager,
    createPasswordVault(state.db, cipher)
  )
})

afterEach(() => {
  state.db.close()
  vi.restoreAllMocks()
})

function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`No handler registered for "${channel}"`)
  return Promise.resolve(handler({}, ...args) as IpcResult<T>)
}

type Stored = { password_enc: string | null; password_cipher: Buffer | null }

function stored(id: number | undefined): Stored {
  return state.db
    .prepare('SELECT password_enc, password_cipher FROM servers WHERE id = ?')
    .get(id) as Stored
}

const NAS: FtpServerInput = {
  name: 'NAS',
  host: 'nas.local',
  port: 21,
  username: 'alice',
  secure: false
}

async function save(input: FtpServerInput): Promise<FtpServer> {
  const result = await invoke<FtpServer>('ftp:saveServer', input)
  if (!result.success) throw new Error(result.error)
  return result.data
}

describe('saved servers sent to the renderer', () => {
  it('never include a saved password, encrypted or legacy plain text', async () => {
    // covers: Test-712
    const saved = await save({ ...NAS, password: 'cipher-Secret-712' })
    state.db
      .prepare(
        "INSERT INTO servers (name, host, port, username, password_enc, last_connected) VALUES ('', 'old.example', 21, 'bob', 'legacy-Secret-712', datetime('now'))"
      )
      .run()

    const recent = await invoke<FtpServer[]>('ftp:getRecentServers')
    const last = await invoke<FtpServer | null>('ftp:getLastServer')

    expect(recent).toMatchObject({
      success: true,
      data: [
        expect.objectContaining({ host: 'old.example', hasPassword: true }),
        expect.objectContaining({ id: saved.id, hasPassword: true })
      ]
    })
    expect(last).toMatchObject({
      success: true,
      data: expect.objectContaining({ host: 'old.example', hasPassword: true })
    })
    for (const result of [recent, last]) {
      const json = JSON.stringify(result)
      expect(json).not.toContain('Secret-712')
      expect(json).not.toContain('"password')
      expect(json).not.toContain('Buffer')
    }
  })
})

describe('ftp:connect', () => {
  it('logs in with the decrypted saved password and keeps it; a typed password is encrypted and saved', async () => {
    // covers: Test-713
    const { id } = await save({ ...NAS, password: 'saved-pw' })
    const before = stored(id)

    const viaSaved = await invoke('ftp:connect', {
      id,
      savedPasswordOf: id,
      host: 'nas.local',
      port: 21,
      user: 'alice',
      secure: false
    })

    expect(viaSaved).toEqual({ success: true, data: undefined })
    expect(state.connect).toHaveBeenCalledTimes(1)
    expect(state.connect.mock.calls[0][0]).toMatchObject({ user: 'alice', password: 'saved-pw' })
    expect(state.connect.mock.calls[0][0]).not.toHaveProperty('savedPasswordOf')
    expect(stored(id)).toEqual(before)
    expect(cipher.encryptCalls).toBe(1) // 저장할 때 한 번뿐이다

    const typed = await invoke('ftp:connect', {
      id,
      host: 'nas.local',
      port: 21,
      user: 'alice',
      password: 'typed-pw',
      secure: false
    })

    expect(typed).toEqual({ success: true, data: undefined })
    expect(state.connect.mock.calls[1][0]).toMatchObject({ user: 'alice', password: 'typed-pw' })
    expect(stored(id)).toEqual({ password_enc: null, password_cipher: fakeCipherOf('typed-pw') })
  })

  it('does not try to connect when the saved password cannot be decrypted', async () => {
    // covers: Test-714
    const { id } = await save({ ...NAS, password: 'saved-pw' })
    const before = stored(id)
    cipher.failDecrypt = true
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await invoke('ftp:connect', {
      id,
      savedPasswordOf: id,
      host: 'nas.local',
      port: 21,
      user: 'alice',
      secure: false
    })

    expect(result).toMatchObject({ success: false, code: ErrorCode.SAVED_PASSWORD_UNREADABLE })
    expect(state.connect).not.toHaveBeenCalled()
    expect(stored(id)).toEqual(before)
  })
})

describe('ftp:saveServer', () => {
  it('keeps the password for undefined, removes it for "" and replaces it for a value', async () => {
    // covers: Test-715
    const { id } = await save({ ...NAS, password: 'first-pw' })
    expect(stored(id)).toEqual({ password_enc: null, password_cipher: fakeCipherOf('first-pw') })

    expect(await save({ ...NAS, id, name: 'Renamed' })).toMatchObject({
      name: 'Renamed',
      hasPassword: true
    })
    expect(stored(id)).toEqual({ password_enc: null, password_cipher: fakeCipherOf('first-pw') })

    expect(await save({ ...NAS, id, password: 'second-pw' })).toMatchObject({ hasPassword: true })
    expect(stored(id)).toEqual({ password_enc: null, password_cipher: fakeCipherOf('second-pw') })

    expect(await save({ ...NAS, id, password: '' })).toMatchObject({ hasPassword: false })
    expect(stored(id)).toEqual({ password_enc: null, password_cipher: null })
  })
})

describe('ftp:getPasswordProtection', () => {
  it('reports the protection level as an IpcResult', async () => {
    // covers: Test-716
    expect(await invoke('ftp:getPasswordProtection')).toEqual({
      success: true,
      data: { level: 'basic' }
    })
    cipher.available = false
    expect(await invoke('ftp:getPasswordProtection')).toEqual({
      success: true,
      data: { level: 'none' }
    })
  })
})

describe('ftp:connect — a saved password stays with its server', () => {
  const REFUSED = {
    success: false,
    error:
      'The saved password can only be used for the server it was saved for. Enter the password.'
  }
  const rows = (): unknown[] => state.db.prepare('SELECT * FROM servers ORDER BY id').all()

  it('refuses savedPasswordOf for another host, port or user without logging in or saving', async () => {
    // covers: Test-730
    const { id } = await save({ ...NAS, password: 'saved-Secret-730' })
    const before = rows()
    const decrypt = vi.spyOn(cipher, 'decryptStringAsync')

    for (const other of [
      // 실제 앱 E2E: 같은 호스트의 다른 포트(다른 서버)로 보내 새 행으로 저장했다
      { host: 'nas.local', port: 2121, user: 'alice' },
      { host: 'rogue.example', port: 21, user: 'alice' },
      { host: 'nas.local', port: 21, user: 'mallory' },
      { host: 'nas.local', port: 21, user: 'anonymous' }
    ]) {
      const result = await invoke('ftp:connect', { ...other, savedPasswordOf: id, secure: false })
      expect(result, JSON.stringify(other)).toEqual(REFUSED)
    }

    expect(state.connect).not.toHaveBeenCalled()
    expect(decrypt).not.toHaveBeenCalled()
    expect(rows()).toEqual(before)
  })

  it('refuses another server id to update, and a server that is no longer saved', async () => {
    // covers: Test-731
    const a = await save({ ...NAS, password: 'a-Secret-731' })
    const b = await save({ ...NAS, host: 'b.local', password: 'b-Secret-731' })
    const gone = await save({ ...NAS, host: 'gone.local', password: 'gone-Secret-731' })
    state.db.prepare('DELETE FROM servers WHERE id = ?').run(gone.id)
    const before = rows()

    // B의 주소·계정이지만 갱신할 서버는 A: 성공하면 A의 비밀번호를 B의 것으로 덮었다
    expect(
      await invoke('ftp:connect', {
        id: a.id,
        savedPasswordOf: b.id,
        host: 'b.local',
        port: 21,
        user: 'alice',
        secure: false
      })
    ).toEqual(REFUSED)
    // 지운 서버: 'anonymous@'로 로그인해 새 행으로 저장하지 않는다
    expect(
      await invoke('ftp:connect', {
        savedPasswordOf: gone.id,
        host: 'gone.local',
        port: 21,
        user: 'alice',
        secure: false
      })
    ).toEqual(REFUSED)

    expect(state.connect).not.toHaveBeenCalled()
    expect(rows()).toEqual(before)
  })

  it('accepts the saved address in any host case, anonymous in any spelling, and FTPS turned off', async () => {
    // covers: Test-732
    const { id } = await save({ ...NAS, host: 'NAS.local', secure: true, password: 'nas-Secret' })
    const anon = await save({ ...NAS, host: 'anon.local', username: '', password: 'anon-Secret' })
    const before = rows()

    const logins = [
      // FTPS는 사용자가 일부러 끌 수 있다(남은 위험, 명세 §8)
      { id, savedPasswordOf: id, host: ' nas.LOCAL ', port: 21, user: 'alice', secure: false },
      { savedPasswordOf: id, host: 'NAS.local', port: 21, user: 'alice', secure: true },
      {
        id: anon.id,
        savedPasswordOf: anon.id,
        host: 'anon.local',
        port: 21,
        user: 'ANONYMOUS',
        secure: false
      }
    ]
    for (const login of logins) {
      expect(await invoke('ftp:connect', login), JSON.stringify(login)).toEqual({
        success: true,
        data: undefined
      })
    }

    expect(state.connect.mock.calls.map(([config]) => config.password)).toEqual([
      'nas-Secret',
      'nas-Secret',
      'anon-Secret'
    ])
    expect(state.connect.mock.calls[0][0]).toMatchObject({ secure: false })
    const passwordsOf = (all: unknown[]): unknown[] =>
      (all as Array<{ password_enc: unknown; password_cipher: unknown }>).map((r) => [
        r.password_enc,
        r.password_cipher
      ])
    expect(passwordsOf(rows())).toEqual(passwordsOf(before))
  })
})

describe('ftp:saveServer — a saved password stays with its address', () => {
  it('refuses to move a server that keeps its saved password to another host or port', async () => {
    // covers: Test-734
    // 주소를 옮기면 최근 경로도 따라 옮긴다(initDatabase가 만드는 표)
    state.db.exec(`CREATE TABLE server_recent_paths (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_host TEXT NOT NULL,
      server_port INTEGER NOT NULL,
      path TEXT NOT NULL,
      last_visited TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(server_host, server_port, path)
    )`)
    const { id } = await save({ ...NAS, host: 'NAS.local', password: 'saved-Secret-734' })
    const rows = (): unknown[] => state.db.prepare('SELECT * FROM servers ORDER BY id').all()
    const before = rows()

    for (const moved of [{ host: 'other.local' }, { port: 2121 }]) {
      const result = await invoke<FtpServer>('ftp:saveServer', {
        ...NAS,
        host: 'NAS.local',
        id,
        ...moved
      })
      expect(result, JSON.stringify(moved)).toMatchObject({
        success: false,
        code: ErrorCode.SAVED_PASSWORD_ADDRESS_CHANGED
      })
    }
    expect(rows()).toEqual(before)

    // 별칭·사용자·FTPS·동시 전송 수, 대소문자만 다른 호스트는 같은 주소라 비밀번호를 그대로 둔다
    expect(
      await save({
        ...NAS,
        id,
        host: 'nas.LOCAL',
        name: 'Renamed',
        username: 'bob',
        secure: true,
        maxTransfers: 4
      })
    ).toMatchObject({ host: 'nas.LOCAL', username: 'bob', hasPassword: true })
    expect(stored(id)).toEqual({
      password_enc: null,
      password_cipher: fakeCipherOf('saved-Secret-734')
    })

    // 새 비밀번호를 입력하거나 지우면 옮길 수 있다. 비밀번호가 없는 서버는 그대로 옮긴다.
    expect(await save({ ...NAS, id, host: 'moved.local', password: 'new-pw' })).toMatchObject({
      host: 'moved.local',
      hasPassword: true
    })
    expect(stored(id).password_cipher).toEqual(fakeCipherOf('new-pw'))
    expect(await save({ ...NAS, id, host: 'moved.local', port: 2121, password: '' })).toMatchObject(
      { port: 2121, hasPassword: false }
    )
    expect(await save({ ...NAS, id, host: 'again.local', port: 2222 })).toMatchObject({
      host: 'again.local',
      port: 2222,
      hasPassword: false
    })
  })
})

describe('ftp:connect — quick connect', () => {
  it('encrypts and saves the typed password of a server it saves for the first time', async () => {
    // covers: Test-740
    const result = await invoke('ftp:connect', {
      host: 'quick.example',
      port: 21,
      user: 'bob',
      password: 'typed-Secret-740',
      secure: false
    })

    expect(result).toEqual({ success: true, data: undefined })
    expect(
      state.db
        .prepare(
          "SELECT username, password_enc, password_cipher FROM servers WHERE host = 'quick.example'"
        )
        .get()
    ).toEqual({
      username: 'bob',
      password_enc: null,
      password_cipher: fakeCipherOf('typed-Secret-740')
    })
  })

  it("never rewrites a saved server's login from a connect to another address", async () => {
    // covers: Test-745
    const nas = await save({ ...NAS, password: 'nas-Secret-745' })
    const before = stored(nas.id)

    const result = await invoke('ftp:connect', {
      id: nas.id,
      host: 'other.example',
      port: 2121,
      user: 'mallory',
      password: 'typed-Secret-745',
      secure: false
    })

    expect(result).toEqual({ success: true, data: undefined })
    // NAS의 계정과 비밀번호는 그대로이고, 접속한 주소는 그 주소의 서버로 따로 기록된다
    expect(stored(nas.id)).toEqual(before)
    expect(
      state.db.prepare('SELECT username FROM servers WHERE id = ?').get(nas.id) as {
        username: string
      }
    ).toEqual({ username: 'alice' })
    expect(
      state.db
        .prepare(
          "SELECT username, password_cipher FROM servers WHERE host = 'other.example' AND port = 2121"
        )
        .get()
    ).toEqual({ username: 'mallory', password_cipher: fakeCipherOf('typed-Secret-745') })
  })
})
