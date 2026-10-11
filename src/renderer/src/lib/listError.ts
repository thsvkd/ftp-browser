/** 목록 실패를 `IpcResult.code`로 분류하고(정규식 아님), 종류마다 패널이 내놓을 행동을 정한다. */
import { ErrorCode, type ErrorCodeType } from '@shared/types/ipc'

/** i18n `listError.<kind>`·`listError.<kind>Hint`의 kind */
export type ListErrorKind = 'permission' | 'notFound' | 'lost' | 'other'
export type ListErrorAction = 'retry' | 'up' | 'reconnect'

const KIND: Partial<Record<ErrorCodeType, ListErrorKind>> = {
  [ErrorCode.FTP_PERMISSION_DENIED]: 'permission',
  [ErrorCode.FS_PERMISSION_DENIED]: 'permission',
  [ErrorCode.FTP_NOT_FOUND]: 'notFound',
  [ErrorCode.FS_NOT_FOUND]: 'notFound',
  [ErrorCode.CONNECTION_RESET]: 'lost',
  [ErrorCode.FTP_NOT_CONNECTED]: 'lost'
}

export function listErrorKind(code: ErrorCodeType | undefined): ListErrorKind {
  return (code && KIND[code]) || 'other'
}

const ACTIONS: Record<ListErrorKind, ListErrorAction[]> = {
  permission: ['retry', 'up'],
  notFound: ['retry', 'up'],
  lost: ['reconnect'],
  other: ['retry']
}

export function listErrorActions(kind: ListErrorKind): ListErrorAction[] {
  return ACTIONS[kind]
}
