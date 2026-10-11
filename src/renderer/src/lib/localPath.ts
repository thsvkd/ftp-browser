/**
 * 크로스 플랫폼 로컬 경로 유틸리티.
 * 렌더러에서는 Node.js path 모듈을 사용할 수 없으므로
 * 경로 문자열에서 OS를 감지하여 처리한다.
 */

const SEP_RE = /[\\/]/

/** Windows 드라이브 경로인지 (예: C:\, D:\) */
function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p)
}

/** 상위 디렉토리 경로 반환. 루트면 null */
export function getParentPath(p: string): string | null {
  if (isWindowsPath(p)) {
    // 후행 구분자 제거 (C:\ 제외)
    const trimmed = p.length > 3 && SEP_RE.test(p[p.length - 1]) ? p.slice(0, -1) : p
    const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    // C:\ 루트 — 더 위로 갈 수 없음
    if (trimmed.length <= 3) return null
    // C:\Users처럼 루트 바로 아래면 부모는 드라이브 루트다
    if (lastSep <= 2) return trimmed.slice(0, 3)
    return trimmed.substring(0, lastSep)
  }

  // Unix
  if (p === '/') return null
  const trimmed = p.endsWith('/') && p.length > 1 ? p.slice(0, -1) : p
  const lastSep = trimmed.lastIndexOf('/')
  if (lastSep <= 0) return '/'
  return trimmed.substring(0, lastSep)
}

/** 디렉토리 경로와 파일명을 결합 */
export function joinLocalPath(dir: string, name: string): string {
  if (isWindowsPath(dir)) {
    const sep = '\\'
    return dir.endsWith(sep) ? dir + name : dir + sep + name
  }
  return dir.endsWith('/') ? dir + name : dir + '/' + name
}
