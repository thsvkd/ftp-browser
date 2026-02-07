import { ipcMain, nativeImage, app } from 'electron'
import { join } from 'path'
import { mkdirSync, existsSync, rmSync } from 'fs'
import { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import type { IpcResult } from '@shared/types/ipc'

interface DragFile {
  remotePath: string
  fileName: string
  size: number
}

interface DragStartPayload {
  files: DragFile[]
}

export function registerDragHandlers(manager: FtpConnectionManager): void {
  const tempDir = join(app.getPath('temp'), 'ftp-browser-drag')

  // 이전 임시 파일 정리
  function cleanTempDir(): void {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
    mkdirSync(tempDir, { recursive: true })
  }

  ipcMain.handle(
    'drag:start',
    async (event, payload: DragStartPayload): Promise<IpcResult<void>> => {
      try {
        if (!manager.isConnected()) {
          return { success: false, error: 'Not connected to FTP server' }
        }

        cleanTempDir()

        // secondary client로 다운로드 (메인 클라이언트 충돌 방지)
        const client = await manager.createSecondaryClient()
        const localPaths: string[] = []

        try {
          for (const file of payload.files) {
            const localPath = join(tempDir, file.fileName)
            await client.downloadTo(localPath, file.remotePath)
            localPaths.push(localPath)
          }
        } finally {
          client.close()
        }

        if (localPaths.length === 0) {
          return { success: false, error: 'No files to drag' }
        }

        const icon = nativeImage.createFromBuffer(Buffer.alloc(0))

        event.sender.startDrag({
          file: localPaths[0],
          files: localPaths,
          icon
        })

        return { success: true, data: undefined }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // 앱 종료 시 임시 디렉토리 정리
  app.on('will-quit', () => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
}
