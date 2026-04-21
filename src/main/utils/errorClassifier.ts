import { ErrorCode, type ErrorCodeType } from '@shared/types/ipc'

interface ClassifiedError {
  code: ErrorCodeType
  message: string
}

/** FTP 응답 코드 기반 분류 (RFC 959) */
function classifyFtpResponseCode(ftpCode: number): ClassifiedError | null {
  if (ftpCode === 530) {
    return {
      code: ErrorCode.FTP_AUTH_FAILED,
      message: 'Authentication failed. Check username and password.'
    }
  }
  if (ftpCode === 550) {
    return {
      code: ErrorCode.FTP_PERMISSION_DENIED,
      message: 'Permission denied or file/directory not found.'
    }
  }
  if (ftpCode === 553) {
    return { code: ErrorCode.FTP_PERMISSION_DENIED, message: 'File name not allowed.' }
  }
  if (ftpCode === 551 || ftpCode === 552) {
    return {
      code: ErrorCode.FTP_TRANSFER_FAILED,
      message: 'Storage allocation exceeded or transfer aborted.'
    }
  }
  if (ftpCode >= 500 && ftpCode < 600) {
    return { code: ErrorCode.FTP_SERVER_ERROR, message: `FTP server error (${ftpCode}).` }
  }
  return null
}

/** Node.js 시스템 에러 코드 기반 분류 */
function classifySystemError(err: NodeJS.ErrnoException): ClassifiedError | null {
  switch (err.code) {
    case 'ECONNREFUSED':
      return {
        code: ErrorCode.CONNECTION_REFUSED,
        message: 'Connection refused. Check the host and port.'
      }
    case 'ENOTFOUND':
      return { code: ErrorCode.DNS_NOT_FOUND, message: 'Server not found. Check the hostname.' }
    case 'ETIMEDOUT':
      return {
        code: ErrorCode.CONNECTION_TIMEOUT,
        message: 'Connection timed out. Server may be unreachable.'
      }
    case 'ECONNRESET':
      return { code: ErrorCode.CONNECTION_RESET, message: 'Connection was reset by the server.' }
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
      return {
        code: ErrorCode.NETWORK_UNREACHABLE,
        message: 'Network unreachable. Check your connection.'
      }
    case 'EACCES':
    case 'EPERM':
      return { code: ErrorCode.FS_PERMISSION_DENIED, message: 'Permission denied.' }
    case 'ENOENT':
      return { code: ErrorCode.FS_NOT_FOUND, message: 'File or directory not found.' }
    case 'ENOSPC':
      return { code: ErrorCode.FS_DISK_FULL, message: 'Disk is full.' }
    case 'EEXIST':
      return { code: ErrorCode.FS_ALREADY_EXISTS, message: 'File already exists.' }
    default:
      return null
  }
}

/**
 * 에러를 분류하여 코드와 사용자 친화적 메시지를 반환.
 * basic-ftp의 FTPError, Node.js ErrnoException, 일반 Error 모두 처리.
 */
export function classifyError(err: unknown): ClassifiedError {
  if (!(err instanceof Error)) {
    return { code: ErrorCode.UNKNOWN, message: String(err) }
  }

  // basic-ftp FTPError: err.code가 FTP 응답 코드 (숫자)
  const ftpCode = (err as { code?: number }).code
  if (typeof ftpCode === 'number' && ftpCode >= 100) {
    const classified = classifyFtpResponseCode(ftpCode)
    if (classified) return classified
  }

  // Node.js 시스템 에러
  const errno = err as NodeJS.ErrnoException
  if (errno.code && typeof errno.code === 'string') {
    const classified = classifySystemError(errno)
    if (classified) return classified
  }

  // 메시지 기반 휴리스틱
  const msg = err.message.toLowerCase()
  if (msg.includes('login') || msg.includes('authentication') || msg.includes('530')) {
    return {
      code: ErrorCode.FTP_AUTH_FAILED,
      message: 'Authentication failed. Check username and password.'
    }
  }
  if (msg.includes('timeout') || msg.includes('timed out')) {
    return { code: ErrorCode.CONNECTION_TIMEOUT, message: 'Connection timed out.' }
  }
  if (msg.includes('not connected') || msg.includes('no connection')) {
    return { code: ErrorCode.FTP_NOT_CONNECTED, message: 'Not connected to FTP server.' }
  }

  return { code: ErrorCode.UNKNOWN, message: err.message }
}

/** IpcResult의 실패 형태를 간편하게 생성 */
export function ipcError(err: unknown): { success: false; error: string; code: ErrorCodeType } {
  const { code, message } = classifyError(err)
  return { success: false, error: message, code }
}

/** 재시도 가능한 에러인지 판단 (네트워크/일시적 에러만 재시도) */
export function isRetryableError(err: unknown): boolean {
  const { code } = classifyError(err)
  return (
    code === ErrorCode.CONNECTION_TIMEOUT ||
    code === ErrorCode.CONNECTION_RESET ||
    code === ErrorCode.NETWORK_UNREACHABLE ||
    code === ErrorCode.FTP_TRANSFER_FAILED
  )
}
