import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { ErrorCode } from '@shared/types/ipc'
import { createPasswordVault, type PasswordVault } from './passwordVault'
import { saveServer, type PasswordWrite } from './servers'
import { FakeCipher, fakeCipherOf } from './__fixtures__/fakeCipher'

let db: Database.Database
let cipher: FakeCipher
let vault: PasswordVault

beforeEach(() => {
  db = new Database(':memory:')
  for (const file of [
    '001_initial.sql',
    '002_server_max_transfers.sql',
    '003_server_password_cipher.sql'
  ]) {
    db.exec(fs.readFileSync(path.join(__dirname, 'migrations', file), 'utf-8'))
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_host_port ON servers(host, port)')
  cipher = new FakeCipher()
  vault = createPasswordVault(db, cipher)
})

afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

type Stored = { password_enc: string | null; password_cipher: Buffer | null }

function stored(id: number): Stored {
  return db
    .prepare('SELECT password_enc, password_cipher FROM servers WHERE id = ?')
    .get(id) as Stored
}

/** 예전 앱이 남긴 행: password_enc에 평문 */
function addLegacy(host: string, password: string | null): number {
  return Number(
    db
      .prepare(
        "INSERT INTO servers (name, host, port, username, password_enc) VALUES ('', ?, 21, 'me', ?)"
      )
      .run(host, password).lastInsertRowid
  )
}

function addCipher(host: string, password: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO servers (name, host, port, username, password_cipher) VALUES ('', ?, 21, 'me', ?)"
      )
      .run(host, fakeCipherOf(password)).lastInsertRowid
  )
}

/** console.* 로 남긴 모든 것 */
function spyLogs(): () => string {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => undefined)
  )
  return () =>
    spies
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))))
      .join('\n')
}

describe('migrate', () => {
  it('encrypts every plain-text row once and changes nothing on a second run', async () => {
    // covers: Test-704
    const a = addLegacy('a.example', 'alpha-pw')
    const b = addLegacy('b.example', 'beta-pw')
    const none = addLegacy('c.example', '')
    const missing = addLegacy('d.example', null)
    const already = addCipher('e.example', 'epsilon-pw')
    spyLogs()

    expect(await vault.migrate()).toEqual({ migrated: 2, failed: 0 })

    expect(stored(a)).toEqual({ password_enc: null, password_cipher: fakeCipherOf('alpha-pw') })
    expect(stored(b)).toEqual({ password_enc: null, password_cipher: fakeCipherOf('beta-pw') })
    expect(stored(none)).toEqual({ password_enc: '', password_cipher: null })
    expect(stored(missing)).toEqual({ password_enc: null, password_cipher: null })
    expect(stored(already)).toEqual({
      password_enc: null,
      password_cipher: fakeCipherOf('epsilon-pw')
    })
    expect(await vault.reveal(a)).toBe('alpha-pw')

    const before = db.prepare('SELECT * FROM servers ORDER BY id').all()
    const calls = cipher.encryptCalls
    expect(await vault.migrate()).toEqual({ migrated: 0, failed: 0 })
    expect(db.prepare('SELECT * FROM servers ORDER BY id').all()).toEqual(before)
    expect(cipher.encryptCalls).toBe(calls)
  })

  it('keeps the plain text of a row it cannot encrypt, encrypts the rest and logs no password', async () => {
    // covers: Test-705
    const a = addLegacy('a.example', 'alpha-pw')
    const bad = addLegacy('b.example', 'unlucky-pw')
    const c = addLegacy('c.example', 'gamma-pw')
    cipher.failEncryptOf = 'unlucky-pw'
    const logs = spyLogs()

    expect(await vault.migrate()).toEqual({ migrated: 2, failed: 1 })

    expect(stored(bad)).toEqual({ password_enc: 'unlucky-pw', password_cipher: null })
    expect(stored(a).password_cipher).toEqual(fakeCipherOf('alpha-pw'))
    expect(stored(c).password_cipher).toEqual(fakeCipherOf('gamma-pw'))
    expect(await vault.reveal(bad)).toBe('unlucky-pw')
    const logged = logs()
    expect(logged).toContain(String(bad))
    for (const secret of ['alpha-pw', 'unlucky-pw', 'gamma-pw']) {
      expect(logged).not.toContain(secret)
    }
  })

  it('does not overwrite a row the user changed after it was read', async () => {
    // covers: Test-706
    const id = addLegacy('a.example', 'old-pw')
    const other = addLegacy('b.example', 'other-pw')
    // 마이그레이션이 이 행을 암호화하는 사이 사용자가 새 비밀번호를 저장한다
    cipher.onEncrypt = (plainText) => {
      if (plainText !== 'old-pw') return
      saveServer(
        db,
        { name: '', host: 'a.example', port: 21, username: 'me', secure: false, id },
        { kind: 'cipher', cipher: fakeCipherOf('user-new-pw') }
      )
    }
    spyLogs()

    expect(await vault.migrate()).toEqual({ migrated: 1, failed: 0 })

    expect(stored(id)).toEqual({ password_enc: null, password_cipher: fakeCipherOf('user-new-pw') })
    expect(await vault.reveal(id)).toBe('user-new-pw')
    expect(stored(other).password_cipher).toEqual(fakeCipherOf('other-pw'))
  })
})

describe('reveal', () => {
  it('decrypts a cipher, returns legacy plain text, and "" when nothing is saved', async () => {
    // covers: Test-707
    const encrypted = addCipher('a.example', 'p@ss wörd')
    const legacy = addLegacy('b.example', 'legacy-pw')
    const empty = addLegacy('c.example', '')
    const none = addLegacy('d.example', null)

    expect(await vault.reveal(encrypted)).toBe('p@ss wörd')
    expect(await vault.reveal(legacy)).toBe('legacy-pw')
    expect(await vault.reveal(empty)).toBe('')
    expect(await vault.reveal(none)).toBe('')
  })

  it('throws SAVED_PASSWORD_UNREADABLE when decryption fails and keeps the cipher', async () => {
    // covers: Test-708
    const id = addCipher('a.example', 'keep-me')
    cipher.failDecrypt = true
    const logs = spyLogs()

    await expect(vault.reveal(id)).rejects.toMatchObject({
      code: ErrorCode.SAVED_PASSWORD_UNREADABLE
    })

    expect(stored(id)).toEqual({ password_enc: null, password_cipher: fakeCipherOf('keep-me') })
    expect(logs()).not.toContain('keep-me')
  })

  it('re-encrypts and stores the password when decryption asks for it', async () => {
    // covers: Test-709
    const id = addCipher('a.example', 'rotate-me')
    // 예전 키로 만든 암호문: 복호화는 되지만 다시 암호화하라고 한다
    db.prepare('UPDATE servers SET password_cipher = ? WHERE id = ?').run(
      Buffer.from('v10-old-key'),
      id
    )
    vi.spyOn(cipher, 'decryptStringAsync').mockResolvedValueOnce({
      shouldReEncrypt: true,
      result: 'rotate-me'
    })

    expect(await vault.reveal(id)).toBe('rotate-me')

    expect(stored(id)).toEqual({ password_enc: null, password_cipher: fakeCipherOf('rotate-me') })
    expect(await vault.reveal(id)).toBe('rotate-me')
  })
})

describe('protection', () => {
  it('stores plain text, migrates nothing and reports none when encryption is unavailable', async () => {
    // covers: Test-710
    cipher.available = false
    const legacy = addLegacy('a.example', 'legacy-pw')

    expect(await vault.protection()).toEqual({ level: 'none' })
    expect(await vault.toWrite('typed-pw')).toEqual({ kind: 'plain', password: 'typed-pw' })
    expect(await vault.toWrite(undefined)).toEqual({ kind: 'keep' })
    expect(await vault.toWrite('')).toEqual({ kind: 'clear' })
    expect(await vault.migrate()).toEqual({ migrated: 0, failed: 0 })
    expect(stored(legacy)).toEqual({ password_enc: 'legacy-pw', password_cipher: null })
    expect(cipher.encryptCalls).toBe(0)
  })

  it('reports basic for the Linux basic_text backend and still encrypts; keyring otherwise', async () => {
    // covers: Test-711
    const basic = new FakeCipher({ backend: 'basic_text' })
    const basicVault = createPasswordVault(db, basic)
    expect(await basicVault.protection()).toEqual({ level: 'basic' })
    expect(await basicVault.toWrite('typed-pw')).toEqual({
      kind: 'cipher',
      cipher: fakeCipherOf('typed-pw')
    })
    const legacy = addLegacy('a.example', 'legacy-pw')
    expect(await basicVault.migrate()).toEqual({ migrated: 1, failed: 0 })
    expect(stored(legacy)).toEqual({
      password_enc: null,
      password_cipher: fakeCipherOf('legacy-pw')
    })

    for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
      const linuxVault = createPasswordVault(db, new FakeCipher({ backend }))
      expect(await linuxVault.protection(), backend).toEqual({ level: 'keyring' })
    }
    // macOS·Windows에는 getSelectedStorageBackend가 없다
    expect(await vault.protection()).toEqual({ level: 'keyring' })
    expect(await vault.toWrite('typed-pw')).toEqual({
      kind: 'cipher',
      cipher: fakeCipherOf('typed-pw')
    })
  })
})

describe('review follow-ups', () => {
  it('does not let a re-encryption overwrite a password the user saved or removed meanwhile', async () => {
    // covers: Test-739
    const changed = addCipher('a.example', 'old-pw')
    const removed = addCipher('b.example', 'old-pw')
    // 예전 키로 만든 암호문: 다시 암호화하는 사이 사용자가 새 비밀번호를 저장하거나 지운다
    vi.spyOn(cipher, 'decryptStringAsync').mockResolvedValue({
      shouldReEncrypt: true,
      result: 'old-pw'
    })
    const edit = (id: number, host: string, password: PasswordWrite): void => {
      saveServer(db, { name: '', host, port: 21, username: 'me', secure: false, id }, password)
    }
    cipher.onEncrypt = () =>
      edit(changed, 'a.example', { kind: 'cipher', cipher: fakeCipherOf('new-pw') })
    expect(await vault.reveal(changed)).toBe('old-pw')
    cipher.onEncrypt = () => edit(removed, 'b.example', { kind: 'clear' })
    expect(await vault.reveal(removed)).toBe('old-pw')

    expect(stored(changed)).toEqual({ password_enc: null, password_cipher: fakeCipherOf('new-pw') })
    expect(stored(removed)).toEqual({ password_enc: null, password_cipher: null })
  })

  it('reports basic for a basic_text or unknown Linux backend and keyring for any named store', async () => {
    // covers: Test-741
    const level = async (c: FakeCipher): Promise<string> =>
      (await createPasswordVault(db, c).protection()).level

    for (const backend of ['basic_text', 'unknown']) {
      expect(await level(new FakeCipher({ backend })), backend).toBe('basic')
    }
    for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6', 'future_store']) {
      expect(await level(new FakeCipher({ backend })), backend).toBe('keyring')
    }
    // macOS·Windows(getSelectedStorageBackend 없음)는 비동기 암호화를 쓸 수 있을 때만 keyring
    const macOrWindows = new FakeCipher()
    expect(await level(macOrWindows)).toBe('keyring')
    macOrWindows.available = false
    expect(await level(macOrWindows)).toBe('none')
    const linux = new FakeCipher({ backend: 'gnome_libsecret' })
    linux.available = false
    expect(await level(linux)).toBe('none')
  })
})
