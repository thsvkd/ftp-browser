import path from 'path'
import { normalizeRemotePath } from '../../utils/remotePath'
import { AgentError, MAX_PLAN_ITEMS } from '../types'

// T3. 원격은 1단계 MCP 규칙과 같다: 절대경로, CR·LF·NUL 금지(basic-ftp가 task 안에서 throw하며
// 공유 메인 클라이언트를 막는다). 로컬은 OS 절대경로만 받고 제어문자를 거부한다.
const REMOTE_PATH = /^\/[^\r\n\0]*$/
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

/** 검증한 원격 경로를 끝 슬래시 없이 돌려준다. */
export function checkRemotePath(p: string): string {
  if (typeof p !== 'string' || !REMOTE_PATH.test(p)) {
    throw new AgentError(
      'INVALID_PATH',
      `Invalid remote path ${JSON.stringify(p)}: use an absolute path starting with '/' and no CR, LF or NUL characters.`
    )
  }
  return normalizeRemotePath(p)
}

export function checkLocalPath(p: string): string {
  if (typeof p !== 'string' || !path.isAbsolute(p) || CONTROL_CHARS.test(p)) {
    throw new AgentError(
      'INVALID_PATH',
      `Invalid local path ${JSON.stringify(p)}: use an absolute path without control characters.`
    )
  }
  return p
}

/** T9 */
export function tooManyItems(): AgentError {
  return new AgentError(
    'TOO_MANY_ITEMS',
    `More than ${MAX_PLAN_ITEMS} files in one request. Split it into smaller folders or batches.`
  )
}

/** 다른 대상 폴더 안에 든 대상과 중복을 뺀다. 같은 항목을 두 번 지우거나 받지 않게 한다. */
export function outermost(paths: string[], sep: string): string[] {
  const unique = [...new Set(paths)]
  return unique.filter(
    (p) => !unique.some((o) => o !== p && p.startsWith(o.endsWith(sep) ? o : o + sep))
  )
}
