import { describe, expect, it } from 'vitest'
import { listErrorActions, listErrorKind } from './listError'
import { ErrorCode } from '@shared/types/ipc'

describe('listError', () => {
  it('classifies IpcResult codes and offers actions per kind', () => {
    // covers: Test-780
    expect(listErrorKind(ErrorCode.FTP_PERMISSION_DENIED)).toBe('permission')
    expect(listErrorKind(ErrorCode.FS_PERMISSION_DENIED)).toBe('permission')
    expect(listErrorKind(ErrorCode.FTP_NOT_FOUND)).toBe('notFound')
    expect(listErrorKind(ErrorCode.FS_NOT_FOUND)).toBe('notFound')
    expect(listErrorKind(ErrorCode.CONNECTION_RESET)).toBe('lost')
    expect(listErrorKind(ErrorCode.FTP_NOT_CONNECTED)).toBe('lost')
    expect(listErrorKind(ErrorCode.FTP_SERVER_ERROR)).toBe('other')
    expect(listErrorKind(undefined)).toBe('other')

    expect(listErrorActions('permission')).toEqual(['retry', 'up'])
    expect(listErrorActions('notFound')).toEqual(['retry', 'up'])
    expect(listErrorActions('lost')).toEqual(['reconnect'])
    expect(listErrorActions('other')).toEqual(['retry'])
  })
})
