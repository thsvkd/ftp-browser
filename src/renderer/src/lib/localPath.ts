/**
 * 크로스 플랫폼 로컬 경로 유틸리티.
 * 렌더러에서는 Node.js path 모듈을 사용할 수 없으므로
 * 경로 문자열에서 OS를 감지하여 처리한다.
 */

import { toLocalFileName, uniqueLocalNames } from '@shared/entryName'
import type { TransferEnqueueItem } from '@shared/types/transfer'

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

/** 디렉토리 경로와 파일명을 결합 */
export function joinLocalPath(dir: string, name: string): string {
  if (isWindowsPath(dir)) {
    const sep = '\\'
    return dir.endsWith(sep) ? dir + name : dir + sep + name
  }
  return dir.endsWith('/') ? dir + name : dir + '/' + name
}

/** 현재 경로가 루트인지 확인 */
export function isRootPath(p: string): boolean {
  if (isWindowsPath(p)) {
    return p.length <= 3 // "C:\" or "C:"
  }
  return p === '/'
}

/** 다운로드할 원격 파일 하나. 원격 패널의 드래그 데이터와 같은 모양이다. */
export interface RemoteFileRef {
  remotePath: string
  fileName: string
  size: number
}

/**
 * 원격 파일들을 `localDir` 아래로 받을 전송 항목으로 바꾼다.
 *
 * 원격 이름은 서버가 정한 것이라 그대로 붙이면 Windows에서 `..\x`가 폴더 밖으로 나가고
 * `a:b`는 대체 데이터 스트림이 된다. 로컬 이름은 toLocalFileName으로 고쳐 쓰고, 고쳐도
 * 쓸 수 없는 이름('.'·'..' 등)은 `skipped`로 돌려줘 호출자가 사용자에게 알리게 한다.
 * 고친 이름끼리 겹치면 뒤의 것에 번호를 붙여 서로 덮어쓰지 않게 한다.
 */
export function planDownloads(
  localDir: string,
  files: readonly RemoteFileRef[],
  platform: string
): { items: TransferEnqueueItem[]; skipped: string[] } {
  // 플랫폼을 모를 때(preload 없음) Windows 폴더(드라이브·`\\` UNC 경로)에 더 느슨한 POSIX 규칙을 쓰지 않는다
  const rules = isWindowsPath(localDir) || localDir.startsWith('\\\\') ? 'win32' : platform
  const skipped: string[] = []
  const saved: Array<{ file: RemoteFileRef; name: string }> = []
  for (const file of files) {
    const name = toLocalFileName(file.fileName, rules)
    if (name === null) skipped.push(file.fileName)
    else saved.push({ file, name })
  }
  const names = uniqueLocalNames(
    saved.map(({ name }) => name),
    rules
  )
  const items: TransferEnqueueItem[] = saved.map(({ file }, i) => ({
    localPath: joinLocalPath(localDir, names[i]),
    remotePath: file.remotePath,
    fileName: file.fileName,
    totalBytes: file.size
  }))
  return { items, skipped }
}
