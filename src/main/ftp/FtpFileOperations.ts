import { close, open } from 'fs'
import { stat, unlink } from 'fs/promises'
import { promisify } from 'util'
import type { Client } from 'basic-ftp'
import { FtpConnectionManager } from './FtpConnectionManager'
import { fastUpload } from './fastTransfer'
import { SegmentWriter, downloadInto } from './segmentWriter'

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

// 작은 파일을 많이 받을 때는 파일마다의 open/close 비용이 보인다. fs/promises의 FileHandle은 콜백 fd보다
// 무겁다(Electron 43, 8 KB x 2000개를 연결 16개로: FileHandle 336 ms, fd 319 ms). basic-ftp도 fd를 쓴다.
const openFd = promisify(open)
const closeFd = promisify(close)

/**
 * basic-ftp `downloadTo(localPath, remotePath)`(startAt 0)와 같다. 파일 전체를 끝 없는 최종 구간으로 보는
 * SegmentWriter에 받아, 평문 FTP면 데이터 소켓이 슬랩에 바로 읽어 넣고(downloadInto) TLS면 스트림 경로로
 * 받은 조각을 DOWNLOAD_WRITE_BUFFER까지 모아 한 번에 쓴다. 성공이든 실패든 진행 중인 쓰기가 끝난 뒤에
 * 파일을 닫는다(닫힌 fd 번호가 재사용된 뒤 늦은 쓰기가 다른 파일을 덮지 않게).
 */
async function downloadToFile(
  client: Client,
  localPath: string,
  remotePath: string
): Promise<void> {
  const fd = await openFd(localPath, 'w')
  const writer = new SegmentWriter(fd, { start: 0, end: Number.MAX_SAFE_INTEGER, final: true })
  // basic-ftp가 리스너를 뗀 뒤 남은 쓰기가 실패해도 프로세스가 죽지 않게 한다. 전송 실패는 downloadTo가 알린다.
  writer.on('error', () => {})
  let error: unknown = null
  try {
    await downloadInto(client, writer, remotePath)
  } catch (err) {
    error = err
  }
  await writer.stop()
  await closeFd(fd).catch(() => {})
  if (error === null) return
  // basic-ftp와 같이 아무것도 받지 못한 새 파일만 지운다
  const size = await stat(localPath).then(
    (s) => s.size,
    () => -1
  )
  if (size === 0) await unlink(localPath).catch(() => {})
  throw error
}

export class FtpFileOperations {
  constructor(private manager: FtpConnectionManager) {}

  /**
   * `client`를 주면 그 클라이언트에서 직접 실행한다(전송 풀의 전용 연결). 메인 클라이언트의
   * 직렬 큐(`runOnMainClient`)를 거치지 않으므로 탐색 명령과 서로 막지 않는다.
   * `fast`면 그 클라이언트에서 빠른 업로드(fastTransfer)를 쓴다. 메인 클라이언트는 항상 표준 경로다.
   * 어느 쪽이든 fastUpload가 큰 단위로 읽는다.
   */
  async upload(
    localPath: string,
    remotePath: string,
    onProgress?: ProgressCallback,
    client?: Client,
    fast = false
  ): Promise<void> {
    const task = async (c: Client): Promise<void> => {
      if (onProgress) {
        c.trackProgress((info) => {
          onProgress({ bytes: info.bytes, bytesOverall: info.bytesOverall })
        })
      }
      try {
        await fastUpload(c, localPath, remotePath, Boolean(client && fast))
      } finally {
        c.trackProgress()
      }
    }
    await (client ? task(client) : this.manager.runOnMainClient(task))
    this.manager.emit('mutation', { kind: 'upload', remotePath })
  }

  async download(
    remotePath: string,
    localPath: string,
    onProgress?: ProgressCallback,
    client?: Client
  ): Promise<void> {
    const task = async (c: Client): Promise<void> => {
      if (onProgress) {
        c.trackProgress((info) => {
          onProgress({ bytes: info.bytes, bytesOverall: info.bytesOverall })
        })
      }
      try {
        await downloadToFile(c, localPath, remotePath)
      } finally {
        c.trackProgress()
      }
    }
    await (client ? task(client) : this.manager.runOnMainClient(task))
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
