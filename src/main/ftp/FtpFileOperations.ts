import type { Client } from 'basic-ftp'
import { FtpConnectionManager } from './FtpConnectionManager'

export interface ProgressInfo {
  bytes: number
  bytesOverall: number
}

type ProgressCallback = (info: ProgressInfo) => void

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

  async download(
    remotePath: string,
    localPath: string,
    onProgress?: ProgressCallback
  ): Promise<void> {
    await this.manager.runOnMainClient(async (client) => {
      if (onProgress) {
        client.trackProgress((info) => {
          onProgress({ bytes: info.bytes, bytesOverall: info.bytesOverall })
        })
      }
      try {
        await client.downloadTo(localPath, remotePath)
      } finally {
        client.trackProgress()
      }
    })
  }

  async deleteFile(remotePath: string): Promise<void> {
    await this.manager.runOnMainClient((client) => client.remove(remotePath))
    this.manager.emit('mutation', { kind: 'delete', remotePath })
  }

  async deleteDirectory(remotePath: string): Promise<void> {
    await this.manager.runOnMainClient((client) => client.removeDir(remotePath))
    this.manager.emit('mutation', { kind: 'delete', remotePath })
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
