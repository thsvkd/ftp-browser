import { FtpConnectionManager } from './FtpConnectionManager'

export interface ProgressInfo {
  bytes: number
  bytesOverall: number
}

type ProgressCallback = (info: ProgressInfo) => void

export class FtpFileOperations {
  constructor(private manager: FtpConnectionManager) {}

  async upload(
    localPath: string,
    remotePath: string,
    onProgress?: ProgressCallback
  ): Promise<void> {
    const client = this.manager.getClient()
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
  }

  async download(
    remotePath: string,
    localPath: string,
    onProgress?: ProgressCallback
  ): Promise<void> {
    const client = this.manager.getClient()
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
  }

  async deleteFile(remotePath: string): Promise<void> {
    await this.manager.getClient().remove(remotePath)
  }

  async deleteDirectory(remotePath: string): Promise<void> {
    await this.manager.getClient().removeDir(remotePath)
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.manager.getClient().rename(oldPath, newPath)
  }

  async mkdir(remotePath: string): Promise<void> {
    await this.manager.getClient().ensureDir(remotePath)
    // ensureDir changes cwd, so go back to parent
    const parent = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/'
    await this.manager.getClient().cd(parent)
  }
}
