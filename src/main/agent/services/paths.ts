import path from 'path'
import { AgentError, MAX_PLAN_ITEMS } from '../types'

// T3. 원격은 1단계 MCP 규칙과 같다: 절대경로, CR·LF·NUL 금지(basic-ftp가 task 안에서 throw하며
// 공유 메인 클라이언트를 막는다). 로컬은 OS 절대경로만 받고 제어문자를 거부한다.
const REMOTE_PATH = /^\/[^\r\n\0]*$/
// §9 R5: 원격 경로는 정규형만 받는다. 빈 세그먼트(`//`)·`.`·`..`·루트가 아닌 끝의 `/`를 거부한다.
// 그렇지 않으면 `//uploads`처럼 확인 대화상자에 보인 경로와 실제 대상이 어긋나거나 계획이 끝없이 돈다.
export const CANONICAL_REMOTE_PATH = /^(?:\/|(?:\/(?!\.\.?(?:\/|$))[^/\r\n\0]+)+)$/
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

export const NORMALIZED_REMOTE_HINT =
  "use a normalized absolute path such as '/photos/2024': no empty, '.' or '..' segments and no trailing '/' except for the root '/'"

/** 로컬 경로의 `..` 세그먼트. 구분자는 두 가지 다 본다(Windows는 `/`도 받는다). */
export function hasParentSegment(p: string): boolean {
  return p.split(/[\\/]/).includes('..')
}

/** 검증한 원격 경로를 그대로 돌려준다(정규형만 통과한다). */
export function checkRemotePath(p: string): string {
  if (typeof p !== 'string' || !REMOTE_PATH.test(p)) {
    throw new AgentError(
      'INVALID_PATH',
      `Invalid remote path ${JSON.stringify(p)}: use an absolute path starting with '/' and no CR, LF or NUL characters.`
    )
  }
  if (!CANONICAL_REMOTE_PATH.test(p)) {
    throw new AgentError(
      'INVALID_PATH',
      `Invalid remote path ${JSON.stringify(p)}: ${NORMALIZED_REMOTE_HINT}.`
    )
  }
  return p
}

export function checkLocalPath(p: string): string {
  if (
    typeof p !== 'string' ||
    !path.isAbsolute(p) ||
    CONTROL_CHARS.test(p) ||
    hasParentSegment(p)
  ) {
    throw new AgentError(
      'INVALID_PATH',
      `Invalid local path ${JSON.stringify(p)}: use an absolute path without '..' segments or control characters.`
    )
  }
  return p
}

/**
 * §9 R2: `target`이 `root` 자신이거나 그 아래인지. 정규화한 절대경로로 비교한다(`..`·`.`·중복 구분자).
 * Windows는 대소문자를 가리지 않는다. macOS는 대소문자 구분 볼륨도 있어 가린다(밖으로 보면 묻기만 한다).
 */
export function isInsideFolder(
  root: string,
  target: string,
  platform: string = process.platform
): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix
  const fold = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s)
  const base = fold(p.resolve(root))
  const full = fold(p.resolve(target))
  return full === base || full.startsWith(base.endsWith(p.sep) ? base : base + p.sep)
}

/**
 * §9 R2 에이전트 폴더. 다운로드 폴더가 홈 자신·홈의 상위·파일시스템 루트면 `<home>/Downloads`로 대신한다:
 * user-dirs.dirs가 없는 Linux에서 Electron의 getPath('downloads')는 홈을 주므로, 그대로 쓰면 `~/.ssh`·
 * 자동 실행 폴더가 묻지 않고 쓰이는 폴더 안이 된다(b12e936 E2E). 없는 폴더는 `download`가 만든다.
 * 넓은 쪽으로 틀리면 안 되므로 macOS도 대소문자를 가리지 않고 비교한다.
 */
export function agentFolderPath(
  downloads: string,
  home: string,
  platform: string = process.platform
): string {
  const p = platform === 'win32' ? path.win32 : path.posix
  const fold = (s: string): string => (platform === 'darwin' ? s.toLowerCase() : s)
  const full = p.resolve(downloads)
  const tooWide = p.dirname(full) === full || isInsideFolder(fold(full), fold(home), platform)
  return tooWide ? p.join(p.resolve(home), 'Downloads') : downloads
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
