import { describe, it, expect } from 'vitest'
import { classifyError, ipcError, isRetryableError } from './errorClassifier'
import { ErrorCode } from '@shared/types/ipc'

/** basic-ftp FTPError처럼 숫자 code를 가진 Error 생성 */
function makeFtpError(code: number, message: string): Error {
  const err = new Error(message) as Error & { code: number }
  err.code = code
  return err
}

/** Node.js ErrnoException 생성 */
function makeSystemError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException
  err.code = code
  return err
}

describe('classifyError', () => {
  describe('non-Error values', () => {
    it('should return UNKNOWN for string', () => {
      const result = classifyError('something went wrong')
      expect(result.code).toBe(ErrorCode.UNKNOWN)
      expect(result.message).toBe('something went wrong')
    })

    it('should return UNKNOWN for null', () => {
      const result = classifyError(null)
      expect(result.code).toBe(ErrorCode.UNKNOWN)
    })

    it('should return UNKNOWN for number', () => {
      const result = classifyError(42)
      expect(result.code).toBe(ErrorCode.UNKNOWN)
      expect(result.message).toBe('42')
    })
  })

  describe('FTP response codes', () => {
    it('should classify 530 as FTP_AUTH_FAILED', () => {
      const result = classifyError(makeFtpError(530, '530 Login incorrect'))
      expect(result.code).toBe(ErrorCode.FTP_AUTH_FAILED)
    })

    it('should classify 550 as FTP_PERMISSION_DENIED', () => {
      const result = classifyError(makeFtpError(550, '550 No such file'))
      expect(result.code).toBe(ErrorCode.FTP_PERMISSION_DENIED)
    })

    it('should classify 553 as FTP_PERMISSION_DENIED', () => {
      const result = classifyError(makeFtpError(553, '553 File name not allowed'))
      expect(result.code).toBe(ErrorCode.FTP_PERMISSION_DENIED)
    })

    it('should classify 551 as FTP_TRANSFER_FAILED', () => {
      const result = classifyError(makeFtpError(551, '551 Requested action aborted'))
      expect(result.code).toBe(ErrorCode.FTP_TRANSFER_FAILED)
    })

    it('should classify 552 as FTP_TRANSFER_FAILED', () => {
      const result = classifyError(makeFtpError(552, '552 Storage allocation exceeded'))
      expect(result.code).toBe(ErrorCode.FTP_TRANSFER_FAILED)
    })

    it('should classify other 5xx codes as FTP_SERVER_ERROR', () => {
      const result = classifyError(makeFtpError(500, '500 Syntax error'))
      expect(result.code).toBe(ErrorCode.FTP_SERVER_ERROR)
      expect(result.message).toContain('500')
    })

    it('should classify 502 as FTP_SERVER_ERROR', () => {
      const result = classifyError(makeFtpError(502, '502 Command not implemented'))
      expect(result.code).toBe(ErrorCode.FTP_SERVER_ERROR)
    })

    it('should not classify codes below 500 as FTP errors', () => {
      const result = classifyError(makeFtpError(200, '200 OK'))
      expect(result.code).toBe(ErrorCode.UNKNOWN)
    })
  })

  describe('Node.js system errors', () => {
    it('should classify ECONNREFUSED as CONNECTION_REFUSED', () => {
      const result = classifyError(makeSystemError('ECONNREFUSED', 'connect ECONNREFUSED'))
      expect(result.code).toBe(ErrorCode.CONNECTION_REFUSED)
    })

    it('should classify ENOTFOUND as DNS_NOT_FOUND', () => {
      const result = classifyError(makeSystemError('ENOTFOUND', 'getaddrinfo ENOTFOUND'))
      expect(result.code).toBe(ErrorCode.DNS_NOT_FOUND)
    })

    it('should classify ETIMEDOUT as CONNECTION_TIMEOUT', () => {
      const result = classifyError(makeSystemError('ETIMEDOUT', 'connect ETIMEDOUT'))
      expect(result.code).toBe(ErrorCode.CONNECTION_TIMEOUT)
    })

    it('should classify ECONNRESET as CONNECTION_RESET', () => {
      const result = classifyError(makeSystemError('ECONNRESET', 'read ECONNRESET'))
      expect(result.code).toBe(ErrorCode.CONNECTION_RESET)
    })

    it('should classify ENETUNREACH as NETWORK_UNREACHABLE', () => {
      const result = classifyError(makeSystemError('ENETUNREACH', 'network unreachable'))
      expect(result.code).toBe(ErrorCode.NETWORK_UNREACHABLE)
    })

    it('should classify EHOSTUNREACH as NETWORK_UNREACHABLE', () => {
      const result = classifyError(makeSystemError('EHOSTUNREACH', 'host unreachable'))
      expect(result.code).toBe(ErrorCode.NETWORK_UNREACHABLE)
    })

    it('should classify EACCES as FS_PERMISSION_DENIED', () => {
      const result = classifyError(makeSystemError('EACCES', 'permission denied'))
      expect(result.code).toBe(ErrorCode.FS_PERMISSION_DENIED)
    })

    it('should classify EPERM as FS_PERMISSION_DENIED', () => {
      const result = classifyError(makeSystemError('EPERM', 'operation not permitted'))
      expect(result.code).toBe(ErrorCode.FS_PERMISSION_DENIED)
    })

    it('should classify ENOENT as FS_NOT_FOUND', () => {
      const result = classifyError(makeSystemError('ENOENT', 'no such file'))
      expect(result.code).toBe(ErrorCode.FS_NOT_FOUND)
    })

    it('should classify ENOSPC as FS_DISK_FULL', () => {
      const result = classifyError(makeSystemError('ENOSPC', 'no space left on device'))
      expect(result.code).toBe(ErrorCode.FS_DISK_FULL)
    })

    it('should classify EEXIST as FS_ALREADY_EXISTS', () => {
      const result = classifyError(makeSystemError('EEXIST', 'file already exists'))
      expect(result.code).toBe(ErrorCode.FS_ALREADY_EXISTS)
    })

    it('should fall through unknown system error codes', () => {
      const result = classifyError(makeSystemError('EUNKNOWN', 'something'))
      expect(result.code).toBe(ErrorCode.UNKNOWN)
    })
  })

  describe('message-based heuristics', () => {
    it('should detect "login" as auth failure', () => {
      const result = classifyError(new Error('Login failed'))
      expect(result.code).toBe(ErrorCode.FTP_AUTH_FAILED)
    })

    it('should detect "authentication" as auth failure', () => {
      const result = classifyError(new Error('Authentication error occurred'))
      expect(result.code).toBe(ErrorCode.FTP_AUTH_FAILED)
    })

    it('should detect "530" in message as auth failure', () => {
      const result = classifyError(new Error('FTP response 530'))
      expect(result.code).toBe(ErrorCode.FTP_AUTH_FAILED)
    })

    it('should detect "timeout" as connection timeout', () => {
      const result = classifyError(new Error('Request timeout'))
      expect(result.code).toBe(ErrorCode.CONNECTION_TIMEOUT)
    })

    it('should detect "timed out" as connection timeout', () => {
      const result = classifyError(new Error('Connection timed out'))
      expect(result.code).toBe(ErrorCode.CONNECTION_TIMEOUT)
    })

    it('should detect "not connected" as FTP_NOT_CONNECTED', () => {
      const result = classifyError(new Error('Client is not connected'))
      expect(result.code).toBe(ErrorCode.FTP_NOT_CONNECTED)
    })

    it('should detect "no connection" as FTP_NOT_CONNECTED', () => {
      const result = classifyError(new Error('No connection available'))
      expect(result.code).toBe(ErrorCode.FTP_NOT_CONNECTED)
    })
  })

  describe('fallback', () => {
    it('should return UNKNOWN with original message for unrecognized errors', () => {
      const result = classifyError(new Error('Something completely unexpected'))
      expect(result.code).toBe(ErrorCode.UNKNOWN)
      expect(result.message).toBe('Something completely unexpected')
    })
  })

  describe('priority: FTP code > system code > heuristic', () => {
    it('should prioritize FTP code over message heuristic', () => {
      const err = makeFtpError(550, 'Login timeout occurred')
      const result = classifyError(err)
      // FTP code 550 takes priority over "timeout" in message
      expect(result.code).toBe(ErrorCode.FTP_PERMISSION_DENIED)
    })
  })
})

describe('ipcError', () => {
  it('should return IpcResult failure shape', () => {
    const result = ipcError(new Error('test error'))
    expect(result.success).toBe(false)
    expect(result.error).toBe('test error')
    expect(result.code).toBe(ErrorCode.UNKNOWN)
  })

  it('should classify and wrap FTP errors', () => {
    const result = ipcError(makeFtpError(530, '530 Login incorrect'))
    expect(result.success).toBe(false)
    expect(result.code).toBe(ErrorCode.FTP_AUTH_FAILED)
  })

  it('should classify and wrap system errors', () => {
    const result = ipcError(makeSystemError('ECONNREFUSED', 'connection refused'))
    expect(result.success).toBe(false)
    expect(result.code).toBe(ErrorCode.CONNECTION_REFUSED)
  })
})

describe('isRetryableError', () => {
  it('should return true for CONNECTION_TIMEOUT', () => {
    expect(isRetryableError(makeSystemError('ETIMEDOUT', 'timed out'))).toBe(true)
  })

  it('should return true for CONNECTION_RESET', () => {
    expect(isRetryableError(makeSystemError('ECONNRESET', 'reset'))).toBe(true)
  })

  it('should return true for NETWORK_UNREACHABLE', () => {
    expect(isRetryableError(makeSystemError('ENETUNREACH', 'unreachable'))).toBe(true)
  })

  it('should return true for FTP_TRANSFER_FAILED', () => {
    expect(isRetryableError(makeFtpError(551, 'aborted'))).toBe(true)
  })

  it('should return false for auth failures', () => {
    expect(isRetryableError(makeFtpError(530, 'login failed'))).toBe(false)
  })

  it('should return false for permission denied', () => {
    expect(isRetryableError(makeSystemError('EACCES', 'permission denied'))).toBe(false)
  })

  it('should return false for unknown errors', () => {
    expect(isRetryableError(new Error('random error'))).toBe(false)
  })

  it('should return false for non-Error values', () => {
    expect(isRetryableError('string error')).toBe(false)
  })
})
