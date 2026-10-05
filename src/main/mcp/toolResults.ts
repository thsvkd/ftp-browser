import type { CallToolResult } from '@modelcontextprotocol/server'
import { ErrorCode } from '@shared/types/ipc'
import type { RiskTier } from '@shared/types/agent'
import { AgentError, type AgentErrorCode } from '../agent/types'
import { classifyError } from '../utils/errorClassifier'
import type { ConfirmOutcome } from './confirmationBroker'

const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/gu

/** 원격 이름이나 서버 문구가 섞인 메시지가 안내 문장에 줄을 끼워 넣지 못하게 제어문자를 공백으로 바꾼다(M9). */
export function sanitize(text: string): string {
  return text.replace(CONTROL_CHARS, ' ')
}

/** 결과는 structuredContent와 같은 내용의 JSON 텍스트로 함께 준다(M9). JSON이 개행·제어문자를 이스케이프한다. */
export function jsonResult<T extends Record<string, unknown>>(data: T): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** `CODE: message next-step` 형식의 isError 결과(M10). message만 외부 문구일 수 있다. */
export function codedError(code: string, message: string, next: string): CallToolResult {
  return errorResult(`${code}: ${sanitize(message)} ${next}`)
}

export const NOT_CONNECTED_NEXT =
  'Call connect with a saved server from list_servers (or ask the user to connect in the app), then retry.'

const AGENT_NEXT: Record<AgentErrorCode, string> = {
  NOT_CONNECTED: NOT_CONNECTED_NEXT,
  NOT_FOUND:
    'Check the name or path: list_servers shows saved servers, list_directory and ' +
    'list_local_directory show what exists.',
  TARGET_EXISTS:
    'Choose another name, or delete the existing item first (delete and delete_local are ' +
    'tier D and may need the user to confirm).',
  INVALID_PATH: "Use an absolute path (remote paths start with '/') without control characters.",
  BUSY: 'Wait for the running jobs with wait_for_jobs, or stop them with cancel_jobs, then retry.',
  TOO_MANY_ITEMS: 'Split the request into smaller parts, for example one subfolder per call.'
}

/** FTP·파일 시스템 오류는 classifyError 코드로, AgentError는 그 코드로 바꾼다. 예외를 프로토콜 오류로 던지지 않는다. */
export function toolErrorResult(err: unknown): CallToolResult {
  if (err instanceof AgentError) return codedError(err.code, err.message, AGENT_NEXT[err.code])
  const { code, message } = classifyError(err)
  return codedError(code, message, classifiedNext(code))
}

function classifiedNext(code: string): string {
  switch (code) {
    case ErrorCode.FTP_NOT_CONNECTED:
      return NOT_CONNECTED_NEXT
    case ErrorCode.FTP_PERMISSION_DENIED:
      return 'Check the path by listing its parent directory.'
    case ErrorCode.FTP_SERVER_ERROR:
      // pyftpdlib처럼 없는 디렉터리에 550 대신 501을 주는 서버가 있다.
      return (
        'Check that the path exists by listing its parent directory. If it does, retry once; ' +
        'if it fails again, ask the user to check the connection in the app.'
      )
    case ErrorCode.FS_NOT_FOUND:
      return 'Check the path with list_local_directory.'
    case ErrorCode.FS_ALREADY_EXISTS:
      return AGENT_NEXT.TARGET_EXISTS
    case ErrorCode.FS_PERMISSION_DENIED:
      return 'Choose a folder the user can write to, or ask the user.'
    case ErrorCode.FS_DISK_FULL:
      return 'Ask the user to free disk space.'
    default:
      return 'Retry once; if it fails again, ask the user to check the connection in the app.'
  }
}

const DO_NOT_RETRY = 'do not retry unless the user asks.'

/** 정책·확인으로 실행하지 않은 호출의 결과(P2, P6). CLI는 DENIED_*·CONFIRMATION_*를 거부로 본다. */
export function deniedResult(
  outcome: Exclude<ConfirmOutcome, 'approved'> | 'policy',
  tool: string,
  tier: RiskTier
): CallToolResult {
  switch (outcome) {
    case 'policy':
      return errorResult(
        `DENIED_BY_POLICY: ${tool} is turned off in FTP Browser (tier ${tier} policy: deny). ` +
          `Ask the user to change Settings › Agent access; ${DO_NOT_RETRY}`
      )
    case 'denied':
      return errorResult(
        `DENIED_BY_USER: The user declined ${tool} in FTP Browser. Tell the user; ${DO_NOT_RETRY}`
      )
    case 'timeout':
      return errorResult(
        `CONFIRMATION_TIMEOUT: Nobody answered the confirmation for ${tool} in FTP Browser in ` +
          `time, so it did not run. Tell the user it needs their approval in the app window; ` +
          DO_NOT_RETRY
      )
    case 'unavailable':
      return errorResult(
        `CONFIRMATION_UNAVAILABLE: FTP Browser has no open window to ask the user, so ${tool} ` +
          `did not run. Ask the user to open the app window; ${DO_NOT_RETRY}`
      )
    case 'aborted':
      return errorResult(
        `CONFIRMATION_CANCELLED: The call was cancelled before the user answered, so ${tool} ` +
          `did not run; ${DO_NOT_RETRY}`
      )
  }
}
