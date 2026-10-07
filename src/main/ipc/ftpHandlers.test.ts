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
