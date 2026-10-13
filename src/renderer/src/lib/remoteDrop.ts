import { toast } from 'sonner'
import { t } from '@renderer/i18n'
import { useListingStore } from '@renderer/stores/useListingStore'
import type { IpcResult } from '@shared/types/ipc'

/** Shape stored in the dataTransfer when dragging files out of the remote panel. */
interface RemoteFileDragItem {
  remotePath: string
  fileName: string
  size: number
}

/** A single rename (RNFR/RNTO) move planned for execution. */
export interface RemoteMove {
  oldPath: string
  newPath: string
}

/** Join a POSIX remote directory with a child name/relative path. */
export function joinRemotePath(dir: string, child: string): string {
  return dir === '/' ? `/${child}` : `${dir}/${child}`
}

/** Parent directory of a POSIX remote path (FTP paths always use forward slashes). */
function remoteDirname(remotePath: string): string {
  const slash = remotePath.lastIndexOf('/')
  return slash <= 0 ? '/' : remotePath.slice(0, slash)
}

/**
 * Plan the rename moves for dropping `items` into `targetPath`. Files already
 * living in `targetPath` are skipped (moving them would be a no-op).
 */
export function planRemoteMoves(items: RemoteFileDragItem[], targetPath: string): RemoteMove[] {
  const moves: RemoteMove[] = []
  for (const item of items) {
    if (remoteDirname(item.remotePath) === targetPath) continue
    const newPath = joinRemotePath(targetPath, item.fileName)
    if (newPath === item.remotePath) continue
    moves.push({ oldPath: item.remotePath, newPath })
  }
  return moves
}

/** One RNFR/RNTO on `server`. Resolves the failure reason, or null on success. */
async function rename(server: string, from: string, to: string): Promise<string | null> {
  const result = await window.api.invoke<IpcResult<void>>('ftp:rename', server, from, to)
  return result.success ? null : result.error
}

/**
 * Replace the existing file at `move.newPath` (D32). RNTO onto an existing name replaces it on
 * some servers and fails on others (K4), so park the target under a hidden name, move, then
 * delete the parked file. If the move fails, the target goes back.
 */
async function replaceRemote(server: string, move: RemoteMove): Promise<string | null> {
  const name = move.newPath.slice(move.newPath.lastIndexOf('/') + 1)
  const aside = joinRemotePath(
    remoteDirname(move.newPath),
    `.${name}.${Math.random().toString(36).slice(2, 10)}.old`
  )
  const parked = await rename(server, move.newPath, aside)
  if (parked) return parked
  const moved = await rename(server, move.oldPath, move.newPath)
  if (moved) {
    const back = await rename(server, aside, move.newPath)
    return back ? `${moved} (${aside}: ${back})` : moved
  }
  const result = await window.api.invoke<IpcResult<void>>('ftp:deleteBatch', server, [
    { path: aside, isDirectory: false }
  ])
  return result.success ? null : result.error
}

/**
 * Move dragged remote files into `targetPath` on `server` via FTP rename (RNFR/RNTO). Targets
 * listed in `replace` already exist and are replaced. Resolves true when every planned move
 * succeeded (failures are toasted).
 */
export async function moveRemoteFiles(
  server: string,
  items: RemoteFileDragItem[],
  targetPath: string,
  replace: ReadonlySet<string> = new Set()
): Promise<boolean> {
  const moves = planRemoteMoves(items, targetPath)
  if (moves.length === 0) return true

  let moved = 0
  const errors: string[] = []
  for (const move of moves) {
    const error = replace.has(move.newPath)
      ? await replaceRemote(server, move)
      : await rename(server, move.oldPath, move.newPath)
    if (error === null) moved++
    else errors.push(`${move.newPath}: ${error}`)
  }
  if (errors.length > 0) {
    toast.error(t('toast.moveFailed', { count: errors.length }), {
      description: errors.join('\n')
    })
  }
  if (moved > 0) {
    // 옮긴 쪽과 받은 쪽 폴더의 목록을 다시 읽는다(읽은 적이 있는 것만).
    const dirs = new Set([targetPath, ...moves.map((m) => remoteDirname(m.oldPath))])
    for (const dir of dirs) useListingStore.getState().invalidate('remote', server, dir)
  }
  return errors.length === 0
}
