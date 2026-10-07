import type { PasswordCipher } from '../passwordVault'

const PREFIX = Buffer.from('v10')
const KEY = 0x5a

/**
 * Electron safeStorage 비동기 API의 가짜. 암호문은 `v10` + XOR라 평문이 바이트에 그대로 보이지 않고
 * 되돌릴 수 있다. 스위치로 암호화 불가·암호화 실패·복호화 실패·재암호화 요청·Linux 백엔드를 흉내 낸다.
 */
export class FakeCipher implements PasswordCipher {
  available = true
  /** 이 평문의 암호화만 실패한다 */
  failEncryptOf?: string
  failDecrypt = false
  shouldReEncrypt = false
  /** 암호화가 끝나기 직전에 부른다(그사이 사용자가 저장하는 경우) */
  onEncrypt?: (plainText: string) => void
  encryptCalls = 0
  getSelectedStorageBackend?: () => string

  /** `backend`를 주면 Linux처럼 getSelectedStorageBackend가 생긴다. macOS·Windows에는 없다. */
  constructor(options: { backend?: string } = {}) {
    const { backend } = options
    if (backend !== undefined) this.getSelectedStorageBackend = () => backend
  }

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return this.available
  }

  async encryptStringAsync(plainText: string): Promise<Buffer> {
    this.encryptCalls++
    if (!this.available || plainText === this.failEncryptOf) {
      throw new Error('Encryption is not available.')
    }
    this.onEncrypt?.(plainText)
    return Buffer.concat([PREFIX, xor(Buffer.from(plainText, 'utf8'))])
  }

  async decryptStringAsync(
    encrypted: Buffer
  ): Promise<{ shouldReEncrypt: boolean; result: string }> {
    if (this.failDecrypt || !encrypted.subarray(0, PREFIX.length).equals(PREFIX)) {
      throw new Error(
        'Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.'
      )
    }
    return {
      shouldReEncrypt: this.shouldReEncrypt,
      result: xor(encrypted.subarray(PREFIX.length)).toString('utf8')
    }
  }
}

function xor(bytes: Buffer): Buffer {
  return Buffer.from(Uint8Array.from(bytes, (b) => b ^ KEY))
}

/** 테스트가 기대값을 만들 때 쓴다: 가짜 암호기가 `plainText`에 대해 내는 암호문 */
export function fakeCipherOf(plainText: string): Buffer {
  return Buffer.concat([PREFIX, xor(Buffer.from(plainText, 'utf8'))])
}
