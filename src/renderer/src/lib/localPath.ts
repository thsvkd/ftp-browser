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

/** 경로를 구성 요소로 분리 */
export function splitLocalPath(p: string): string[] {
  return p.split(SEP_RE).filter(Boolean)
}

/** 구성 요소로부터 경로 재조합 (index까지) */
export function buildLocalPath(fullPath: string, parts: string[], upToIndex: number): string {
  const selected = parts.slice(0, upToIndex + 1)
  if (isWindowsPath(fullPath)) {
    // C: + \ + 나머지 → C:\Users\...
    return selected.join('\\')
  }
  return '/' + selected.join('/')
}

/** 상위 디렉토리 경로 반환. 루트면 null */
export function getParentPath(p: string): string | null {
  if (isWindowsPath(p)) {
    // 후행 구분자 제거 (C:\ 제외)
    const trimmed = p.length > 3 && SEP_RE.test(p[p.length - 1]) ? p.slice(0, -1) : p
    const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    // C:\ 루트 — 더 위로 갈 수 없음
    if (lastSep <= 2) return null
    return trimmed.substring(0, lastSep)
  }

  // Unix
  if (p === '/') return null
  const trimmed = p.endsWith('/') && p.length > 1 ? p.slice(0, -1) : p
  const lastSep = trimmed.lastIndexOf('/')
  if (lastSep <= 0) return '/'
  return trimmed.substring(0, lastSep)
}

/** 경로의 루트 표시 텍스트 */
export function getRootLabel(p: string): string {
  if (isWindowsPath(p)) {
    return p.substring(0, 2) // "C:"
  }
  return '/'
}

/** 해당 경로의 루트 경로 */
export function getRootPath(p: string): string {
  if (isWindowsPath(p)) {
    return p.substring(0, 3) // "C:\"
  }
  return '/'
}
