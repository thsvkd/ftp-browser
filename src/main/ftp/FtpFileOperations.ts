import { rm } from 'fs/promises'
import type { Client } from 'basic-ftp'
import { FtpConnectionManager } from './FtpConnectionManager'
import { movePartialIntoPlace, partialPathFor } from '../utils/partialFile'

export interface ProgressInfo {
  bytes: number
  bytesOverall: number
}

type ProgressCallback = (info: ProgressInfo) => void

/** `removed` of `total` entries (files and folders) are gone; `path` is the one just removed. */
export type DeleteProgressCallback = (removed: number, total: number, path: string) => void

/**
 * Create a remote directory tree by issuing an absolute `MKD` for each path level.
 *
 * basic-ftp's built-in `ensureDir` enters every level with `CWD`, but some FTP
 * servers (notably Android-based ones) reject `CWD` into directories whose names
 * contain spaces or characters like `(` / `@` — even when the directory exists and
 * absolute-path `STOR` works fine (`550 CWD to the invalid path`). Issuing only
 * `MKD` with the full path avoids that broken `CWD` step entirely.
 *
 * `MKD` on an existing directory returns a negative reply, which `sendIgnoringError`
 * accepts as the idempotent success case (FileZilla and other clients do the same).
 * A directory that genuinely cannot be created is not silently lost: it surfaces
 * later as a clear `STOR` failure in the transfer queue.
 */
export async function ensureRemoteDir(client: Client, remotePath: string): Promise<void> {
  const segments = remotePath.split('/').filter(Boolean)
  let current = ''
  for (const segment of segments) {
    current += `/${segment}`
    await client.sendIgnoringError(`MKD ${current}`)
  }
}

/**
 * Delete a remote directory and everything under it, addressing every entry by absolute path.
 *
 * basic-ftp's `removeDir` walks the tree with relative `CWD name` / `CDUP` / `LIST` (no path).
 * On the same servers `ensureRemoteDir` works around, that walk leaves children behind and the
 * final `RMD` fails with `550 Directory not empty` — typically as soon as a folder holds a
 * subfolder. Listing by absolute path is exactly what the explorer already does successfully,
 * so the delete reuses it and never changes the working directory.
 *
 * Symbolic links are removed with `DELE`, never followed.
 *
 * The whole tree is listed before anything is deleted, so `onProgress` gets an exact total at
 * no extra cost: it is the same set of `LIST` commands a delete-as-you-go walk would issue.
 */
export async function removeRemoteDirRecursive(
  client: Client,
  remotePath: string,
  onProgress?: DeleteProgressCallback
): Promise<void> {
  const files: string[] = []
  const dirs: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const base = dir.replace(/\/+$/, '')
    for (const entry of await client.list(dir)) {
      if (entry.name === '.' || entry.name === '..') continue
      const child = `${base}/${entry.name}`
      // LIST/MLSD가 심링크로 표시한 항목만 따라가지 않는다. 심링크를 그냥 dir로 보고하는 서버라면
      // 구분할 방법이 없어 따라 들어간다(basic-ftp removeDir도 같다).
      if (entry.isDirectory && !entry.isSymbolicLink && !entry.link) {
        await walk(child)
      } else {
        files.push(child)
      }
    }
    // 후위 순서라 하위 폴더가 항상 부모보다 먼저 온다.
    dirs.push(dir)
  }
  await walk(remotePath)

  const total = files.length + dirs.length
  let removed = 0
  for (const file of files) {
    await client.remove(file)
    onProgress?.(++removed, total, file)
  }
  for (const dir of dirs) {
    await client.removeEmptyDir(dir)
    onProgress?.(++removed, total, dir)
  }
}

export class FtpFileOperations {
  constructor(private manager: FtpConnectionManager) {}

  async upload(
    localPath: string,
    remotePath: string,
    onProgress?: ProgressCallback
  ): Promise<void> {
    await this.manager.runOnMainClient(async (client) => {
      if (onProgress) {
        client.trackProgress((info) => {
          onProgress({ bytes: info.bytes, bytesOverall: info.bytesOverall })
        })
      }
      try {
        await client.uploadFrom(localPath, remotePath)
      } finally {
        client.trackProgress()
      }
    })
    this.manager.emit('mutation', { kind: 'upload', remotePath })
  }

  /**
   * basic-ftp opens the local file with `w` before `RETR` is even sent, and
   * unlinks it when nothing arrived — so downloading straight to `localPath`
   * truncates or deletes an existing file when the transfer fails. Download to a
   * sibling `.part` file and only move it into place once it is complete.
   */
  async download(
    remotePath: string,
    localPath: string,
    onProgress?: ProgressCallback
  ): Promise<void> {
    const partPath = partialPathFor(localPath)
    try {
      await this.manager.runOnMainClient(async (client) => {
        if (onProgress) {
          client.trackProgress((info) => {
            onProgress({ bytes: info.bytes, bytesOverall: info.bytesOverall })
          })
        }
        try {
          await client.downloadTo(partPath, remotePath)
        } finally {
          client.trackProgress()
        }
      })
      await movePartialIntoPlace(partPath, localPath)
    } catch (err) {
      await rm(partPath, { force: true }).catch(() => undefined)
      throw err
    }
  }

  async deleteFile(remotePath: string): Promise<void> {
    await this.manager.runOnMainClient((client) => client.remove(remotePath))
    this.manager.emit('mutation', { kind: 'delete', remotePath })
  }

  async deleteDirectory(remotePath: string, onProgress?: DeleteProgressCallback): Promise<void> {
    try {
      await this.manager.runOnMainClient((client) =>
        removeRemoteDirRecursive(client, remotePath, onProgress)
      )
    } finally {
      // 중간에 실패해도 하위 항목 일부는 이미 지워졌으므로 캐시는 무효화해야 한다.
      this.manager.emit('mutation', { kind: 'delete', remotePath })
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.manager.runOnMainClient((client) => client.rename(oldPath, newPath))
    this.manager.emit('mutation', { kind: 'rename', remotePath: oldPath, newPath })
  }

  async mkdir(remotePath: string): Promise<void> {
    await this.manager.runOnMainClient((client) => ensureRemoteDir(client, remotePath))
    this.manager.emit('mutation', { kind: 'mkdir', remotePath })
  }
}
