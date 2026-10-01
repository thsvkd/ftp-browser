import { ipcMain, nativeImage, app } from 'electron'
import { dirname, join, resolve } from 'path'
import { mkdirSync, existsSync, rmSync } from 'fs'
import { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import { ipcError } from '../utils/errorClassifier'
import { ErrorCode } from '@shared/types/ipc'
import { toLocalFileName, uniqueLocalNames } from '@shared/entryName'
import type { IpcResult } from '@shared/types/ipc'

interface DragFile {
  remotePath: string
  fileName: string
  size: number
}

interface DragStartPayload {
  files: DragFile[]
}

function cannotSave(file: DragFile): IpcResult<void> {
  return { success: false, error: `Cannot save "${file.fileName}" as a local file.` }
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
          return {
            success: false,
            error: 'Not connected to FTP server.',
            code: ErrorCode.FTP_NOT_CONNECTED
          }
        }

        // 원격 이름은 서버가 정한다. 로컬에서 쓸 수 있는 이름으로 고치고, 고친 결과가 임시 폴더
        // 바로 아래가 아니면 하나라도 받기 전에 거부한다 — 일부만 받은 채 끌기를 시작하지 않는다.
        // 고친 이름끼리 겹치면 뒤의 것에 번호를 붙여 서로 덮어쓰지 않게 한다.
        const names: string[] = []
        for (const file of payload.files) {
          const name = toLocalFileName(file.fileName, process.platform)
          if (name === null) return cannotSave(file)
          names.push(name)
        }
        const targets: Array<{ remotePath: string; localPath: string }> = []
        for (const [i, name] of uniqueLocalNames(names, process.platform).entries()) {
          const file = payload.files[i]
          const localPath = join(tempDir, name)
          if (dirname(resolve(localPath)) !== resolve(tempDir)) return cannotSave(file)
          targets.push({ remotePath: file.remotePath, localPath })
        }

        cleanTempDir()

        // secondary client로 다운로드 (메인 클라이언트 충돌 방지)
        const client = await manager.createSecondaryClient()
        const localPaths: string[] = []

        try {
          for (const { remotePath, localPath } of targets) {
            await client.downloadTo(localPath, remotePath)
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
        return ipcError(err)
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
