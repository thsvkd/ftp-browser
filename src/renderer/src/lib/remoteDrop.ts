import { toast } from 'sonner'
import { t } from '@renderer/i18n'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import type { UploadFileEntry } from '@shared/types/local'
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

/**
 * Move dragged remote files into `targetPath` via FTP rename (RNFR/RNTO).
 */
async function moveRemoteFiles(items: RemoteFileDragItem[], targetPath: string): Promise<void> {
  const moves = planRemoteMoves(items, targetPath)
  if (moves.length === 0) return

  let moved = 0
  const errors: string[] = []
  for (const move of moves) {
    const result = await window.api.invoke<IpcResult<void>>(
      'ftp:rename',
      move.oldPath,
      move.newPath
    )
    if (result.success) {
      moved++
    } else {
      errors.push(`${move.newPath}: ${result.error}`)
    }
  }
  if (errors.length > 0) {
    toast.error(t('toast.moveFailed', { count: errors.length }), {
      description: errors.join('\n')
    })
  }
  if (moved > 0) {
    useFtpStore.getState().refresh()
  }
}

/**
 * Upload local/OS files into `targetPath`, expanding dropped folders. Missing
 * remote subdirectories are created by the transfer queue as part of the batch.
 */
async function uploadLocalPaths(localPaths: string[], targetPath: string): Promise<void> {
  const enqueueBatch = useTransferStore.getState().enqueueBatch

  // Expand dropped folders into their files, preserving folder structure.
  const expanded = await window.api.invoke<IpcResult<UploadFileEntry[]>>(
    'local:expandForUpload',
    localPaths
  )
  if (!expanded.success) {
    toast.error(t('toast.readDropFailed'), { description: expanded.error })
    return
  }
  const entries = expanded.data
  const toRemote = (rel: string): string => joinRemotePath(targetPath, rel)

  // Remote subdirectories the batch must create, ancestors included, down from the
  // target (which already exists). The main process issues one MKD per directory
  // through the transfer pool, overlapped with the uploads, so a missing folder
  // that cannot be created surfaces as failed file transfers in the queue.
  const dirs = new Set<string>()
  for (const entry of entries) {
    let dir = remoteDirname(toRemote(entry.relativePath))
    while (dir !== targetPath && dir !== '/' && !dirs.has(dir)) {
      dirs.add(dir)
      dir = remoteDirname(dir)
    }
  }

  const containsFolder = entries.some((entry) => entry.relativePath.includes('/'))
  await enqueueBatch(
    'upload',
    entries.map((entry) => ({
      localPath: entry.localPath,
      remotePath: toRemote(entry.relativePath),
      fileName: entry.relativePath.slice(entry.relativePath.lastIndexOf('/') + 1),
      totalBytes: entry.size
    })),
    containsFolder,
    [...dirs]
  )
}

/**
 * Handle a drop onto the remote panel, targeting `targetPath` (the hovered
 * folder, or the current directory when dropped on empty space).
 *
 * - remote → remote: move files into the target folder.
 * - local / OS → remote: upload files into the target folder.
 *
 * All `dataTransfer` reads happen synchronously before the first await so the
 * data is still available (the browser clears it once the drop event returns).
 */
export async function performRemoteDrop(
  dataTransfer: DataTransfer,
  targetPath: string
): Promise<void> {
  // Intra-server move (dragged from the remote panel).
  const remoteData = dataTransfer.getData('application/x-remote-files')
  if (remoteData) {
    const items = JSON.parse(remoteData) as RemoteFileDragItem[]
    await moveRemoteFiles(items, targetPath)
    return
  }

  // Upload from the local panel (custom MIME) or a native OS drop.
  let localPaths: string[]
  const localFilesData = dataTransfer.getData('application/x-local-files')
  if (localFilesData) {
    const localFiles = JSON.parse(localFilesData) as Array<{ localPath: string }>
    localPaths = localFiles.map((f) => f.localPath)
  } else {
    // Electron 32+ removed File.path; resolve via webUtils-backed bridge.
    localPaths = Array.from(dataTransfer.files)
      .map((f) => window.api.getPathForFile(f))
      .filter((p): p is string => Boolean(p))
  }
  if (localPaths.length === 0) return
  await uploadLocalPaths(localPaths, targetPath)
}
