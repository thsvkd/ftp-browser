import type Database from 'better-sqlite3'
import { ErrorCode } from '@shared/types/ipc'
import type { PasswordProtection } from '@shared/types/ftp'
import {
  getStoredPassword,
  listPlainPasswords,
  replaceCipher,
  replacePlainPassword,
  type PasswordWrite
} from './servers'

/**
 * Electron `safeStorage` 중 쓰는 비동기 API(E2). 동기 API는 Electron 46에서 없어진다.
 * 앱은 `safeStorage`를 그대로 넣고, 테스트는 가짜를 넣는다.
 */
export interface PasswordCipher {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plainText: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>
  /** Linux에만 있다. `basic_text`는 고정 키라 보호가 아니다(E6). */
  getSelectedStorageBackend?(): string
}

/** 저장된 암호문을 이 컴퓨터에서 풀 수 없다(키가 바뀌었거나 DB를 옮김). 암호문은 지우지 않는다(E5). */
export class SavedPasswordUnreadableError extends Error {
  readonly code = ErrorCode.SAVED_PASSWORD_UNREADABLE

  constructor() {
    super('The saved password cannot be read on this computer. Enter it again.')
  }
}

/**
 * 저장된 비밀번호의 암·복호화를 맡는 유일한 곳(E2). 비밀번호 값(평문·암호문)은 로그에 남기지 않는다.
 * DB 쓰기는 servers.ts의 동기 함수가 하고, 여기서는 그 앞뒤의 비동기 암·복호화만 한다(E3).
 */
export interface PasswordVault {
  /** 이 컴퓨터에서 저장된 비밀번호가 얼마나 보호되는지(E6) */
  protection(): Promise<PasswordProtection>
  /** `undefined` → keep, `''` → clear, 값 → 암호문(암호화를 쓸 수 없으면 평문) (E3, E9) */
  toWrite(password: string | undefined): Promise<PasswordWrite>
  /**
   * 로그인에 쓸 저장된 비밀번호. 없으면 `''`. 풀 수 없으면 {@link SavedPasswordUnreadableError}(E5, E8).
   * 복호화가 재암호화를 요청하면 다시 암호화해 비교 후 교체로 저장한다(실패는 로그만).
   */
  reveal(id: number): Promise<string>
  /**
   * 예전 평문 행을 하나씩 암호화한다(E4). 멱등이고, 실패한 행은 평문 그대로 둔다(E5). 모든 행을 옮기면
   * 한 번만 파일을 다시 써서 지난 삭제·변경이 빈 페이지에 남긴 평문을 없앤다(E14).
   */
  migrate(): Promise<{ migrated: number; failed: number }>
}

const isScrubbed = (db: Database.Database): boolean =>
  db.prepare("SELECT 1 FROM settings WHERE key = 'passwordsScrubbed' AND value = '1'").get() !==
  undefined

export function createPasswordVault(db: Database.Database, cipher: PasswordCipher): PasswordVault {
  return {
    async protection() {
      if (!(await cipher.isAsyncEncryptionAvailable())) return { level: 'none' }
      return { level: cipher.getSelectedStorageBackend?.() === 'basic_text' ? 'basic' : 'keyring' }
    },

    async toWrite(password) {
      if (password === undefined) return { kind: 'keep' }
      if (password === '') return { kind: 'clear' }
      if (!(await cipher.isAsyncEncryptionAvailable())) return { kind: 'plain', password }
      return { kind: 'cipher', cipher: await cipher.encryptStringAsync(password) }
    },

    async reveal(id) {
      const stored = getStoredPassword(db, id)
      if (!stored?.cipher) return stored?.plain ?? ''
      let decrypted: { shouldReEncrypt: boolean; result: string }
      try {
        decrypted = await cipher.decryptStringAsync(stored.cipher)
      } catch (err) {
        console.warn(`[passwordVault] Cannot decrypt the saved password of server ${id}:`, err)
        throw new SavedPasswordUnreadableError()
      }
      if (decrypted.shouldReEncrypt) {
        try {
          const fresh = await cipher.encryptStringAsync(decrypted.result)
          replaceCipher(db, id, stored.cipher, fresh)
        } catch (err) {
          console.warn(
            `[passwordVault] Failed to re-encrypt the saved password of server ${id}:`,
            err
          )
        }
      }
      return decrypted.result
    },

    async migrate() {
      let migrated = 0
      let failed = 0
      const rows = listPlainPasswords(db)
      // 옮길 행이 없으면 OS 키 저장소를 건드리지 않는다(새로 설치한 앱, CI 스모크 테스트)
      if (rows.length > 0) {
        // 암호화를 쓸 수 없으면 평문이 그대로 남으므로 파일을 다시 쓸 이유도 없다
        if (!(await cipher.isAsyncEncryptionAvailable())) return { migrated, failed }
        for (const { id, plain } of rows) {
          try {
            const encrypted = await cipher.encryptStringAsync(plain)
            // 그사이 사용자가 바꾼 행은 비교 후 교체가 건너뛴다
            if (replacePlainPassword(db, id, plain, encrypted)) migrated++
          } catch (err) {
            failed++
            console.warn(
              `[passwordVault] Failed to encrypt the saved password of server ${id}:`,
              err
            )
          }
        }
      }
      if (failed === 0 && !isScrubbed(db)) {
        // secure_delete 이전에 지우거나 바꾼 비밀번호는 빈 페이지(freelist)에 평문으로 남는다. 모든 행을
        // 옮긴 뒤 한 번만 파일을 다시 써서 없앤다. 실패한 행이 있으면 다음 시작에서 다시 시도한다.
        try {
          db.exec('VACUUM')
          db.pragma('wal_checkpoint(TRUNCATE)')
          db.prepare(
            "INSERT INTO settings (key, value) VALUES ('passwordsScrubbed', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
          ).run()
        } catch (err) {
          console.warn('[passwordVault] Failed to rewrite the database file:', err)
        }
      } else if (migrated > 0) {
        // 평문이 든 옛 페이지가 DB 파일·WAL에 남지 않게 바로 체크포인트하고 WAL을 비운다
        db.pragma('wal_checkpoint(TRUNCATE)')
      }
      return { migrated, failed }
    }
  }
}
