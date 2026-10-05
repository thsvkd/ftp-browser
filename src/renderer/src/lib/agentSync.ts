/**
 * GUI 동기화(handoff agent-operations §2.5 G1·G2) 판단. main이 알린 변경 경로들과 패널이 보고 있는
 * 폴더를 비교해, 목록을 다시 읽을지(refresh) 지워지거나 옮겨진 폴더를 벗어날지(navigate) 정한다.
 */
import type { FtpMutationEvent } from '@shared/types/ftp'

export type SyncAction = { kind: 'refresh' } | { kind: 'navigate'; path: string } | null

/** POSIX 원격 경로의 부모. 원격 이름에는 `\`가 들어갈 수 있으므로 `/`만 구분자다. */
function remoteParent(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut <= 0 ? '/' : trimmed.slice(0, cut)
}

function remoteWithin(path: string, folder: string): boolean {
  const base = folder.replace(/\/+$/, '')
  return path === folder || path.startsWith(`${base}/`)
}

/** 원격 변경 묶음에 대해 원격 패널이 할 일. 폴더가 사라졌으면 그 부모로, 아니면 새로 고침. */
export function remoteSyncAction(events: FtpMutationEvent[], current: string): SyncAction {
  for (const event of events) {
    const gone = event.kind === 'delete' || event.kind === 'rename'
    if (gone && remoteWithin(current, event.remotePath)) {
      return { kind: 'navigate', path: remoteParent(event.remotePath) }
    }
  }
  const touches = events.some(
    (event) =>
      remoteParent(event.remotePath) === current ||
      (event.newPath !== undefined && remoteParent(event.newPath) === current)
  )
  return touches ? { kind: 'refresh' } : null
}

const isWindowsLike = (path: string): boolean => /^[A-Za-z]:/.test(path) || /^[\\/]{2}/.test(path)

/** 끝 구분자를 뗀 경로. 루트(`/`, `C:\`)도 구분자를 떼므로 비교용으로만 쓴다. */
const stripTrailing = (path: string): string => path.replace(/[\\/]+$/, '')

/** 비교용 표기: Windows 경로는 구분자를 `/`로 맞추고 대소문자를 무시한다. 길이는 바뀌지 않는다. */
function comparable(path: string): string {
  const stripped = stripTrailing(path)
  return isWindowsLike(path) ? stripped.replace(/\\/g, '/').toLowerCase() : stripped
}

/** 로컬 경로의 부모(원래 표기 그대로). 드라이브 바로 아래면 `C:\`, POSIX 최상위면 `/`. */
function localParent(path: string): string {
  const trimmed = stripTrailing(path)
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut < 0) return path
  const head = trimmed.slice(0, cut)
  if (head === '') return '/'
  return /^[A-Za-z]:$/.test(head) ? head + trimmed[cut] : head
}

/** 로컬 변경 경로들에 대해 로컬 패널이 할 일. `remoteSyncAction`과 같은 규칙이다. */
export function localSyncAction(paths: string[], current: string): SyncAction {
  const here = comparable(current)
  for (const path of paths) {
    const changed = comparable(path)
    if (here === changed || here.startsWith(`${changed}/`)) {
      // 패널이 쓰던 표기로 올라간다. 비교용 표기는 길이가 같으므로 같은 위치에서 자른다.
      return { kind: 'navigate', path: localParent(current.slice(0, changed.length)) }
    }
  }
  const touches = paths.some((path) => comparable(localParent(path)) === here)
  return touches ? { kind: 'refresh' } : null
}
