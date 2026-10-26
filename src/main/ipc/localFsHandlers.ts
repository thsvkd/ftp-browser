import { ipcMain, dialog, app, BrowserWindow } from 'electron'
import { stat, mkdir, access, readFile, rmdir } from 'fs/promises'
import { basename, join, dirname, extname, resolve, sep } from 'path'
import { LocalFileSystem } from '../local/LocalFileSystem'
import { OperationManager } from '../operation/OperationManager'
import { ipcError } from '../utils/errorClassifier'
import { MIME_MAP } from './previewHandlers'
import {
  isImageFile,
  isVideoFile,
  MAX_IMAGE_SIZE_BYTES,
  MAX_VIDEO_SIZE_BYTES
} from '@shared/constants'
import { isSafeLocalName } from '@shared/entryName'
import type {
  LocalFileEntry,
  LocalListResult,
  LocalPlaces,
  UploadFileEntry
} from '@shared/types/local'
import type { DeleteTarget } from '@shared/types/operation'
import type { IpcResult } from '@shared/types/ipc'

/** 드라이브 루트가 이 안에 답하지 않으면(끊긴 네트워크 드라이브 등) 장소에서 뺀다 */
const DRIVE_TIMEOUT_MS = 1000

/** 드라이브 루트가 있는지. 응답하지 않는 드라이브가 IPC를 붙잡지 않게 시간을 제한한다(existsSync는 막힌다). */
function driveAnswers(root: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), DRIVE_TIMEOUT_MS)
    access(root)
      .then(
        () => resolve(true),
        () => resolve(false)
      )
      .finally(() => clearTimeout(timer))
  })
}

async function driveRoots(): Promise<string[]> {
  if (process.platform !== 'win32') return ['/']
  const roots = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) => `${letter}:\\`)
  const answers = await Promise.all(roots.map(driveAnswers))
  return roots.filter((_, i) => answers[i])
}

/** app.getPath의 알려진 폴더. 이름을 모르거나(던짐) 폴더가 없으면 null이다. */
async function knownFolder(name: Parameters<typeof app.getPath>[0]): Promise<string | null> {
  try {
    const folder = app.getPath(name)
    await access(folder)
    return folder
  } catch {
    return null
  }
}

interface CopyWorkItem {
  src: string
  dest: string
  size: number
  /** 폴더 원본에서 나온 파일이면 그 원본 폴더(`resolve`로 정규화: 파일 경로의 상위와 글자가 같다) */
  root?: string
}

/** 빈 폴더만 지운다. 비어 있지 않거나 없거나 지울 수 없으면 그대로 두고 실패로 보지 않는다(F1·F2·F16). */
async function removeIfEmpty(dir: string): Promise<void> {
  await rmdir(dir).catch(() => undefined)
}

/** 옮긴 파일의 상위 폴더 가운데 비게 된 것만 원본 폴더까지, 깊은 것부터 지운다(F1). 던지지 않는다. */
async function removeEmptiedDirs(moved: readonly CopyWorkItem[]): Promise<void> {
  const dirs = new Set<string>()
  for (const { src, root } of moved) {
    if (!root) continue
    for (let d = dirname(src); d.length >= root.length && d !== dirname(d); d = dirname(d))
      dirs.add(d)
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) await removeIfEmpty(dir)
}

/** 복사 대상 이름(D32). Windows는 `\`·`:`도 막고, 그 밖은 `/`·`.`·`..`·빈 이름만 막는다. */
export function isSafeCopyName(name: string, platform: string): boolean {
  if (platform === 'win32') return isSafeLocalName(name)
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/')
}

/** 같은 파일인지. Windows·macOS 파일 시스템은 기본으로 대소문자를 가리지 않는다. */
function samePath(a: string, b: string): boolean {
  const fold = process.platform === 'win32' || process.platform === 'darwin'
  return fold ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
}

export function registerLocalFsHandlers(
  win: BrowserWindow,
  operationManager: OperationManager
): LocalFileSystem {
  const localFs = new LocalFileSystem()

  ipcMain.handle(
    'local:list',
    async (_event, dirPath: string): Promise<IpcResult<LocalListResult>> => {
      try {
        const result = await localFs.list(dirPath)
        return { success: true, data: result }
      } catch (err) {
        return ipcError(err)
      }
    }
  )

  ipcMain.handle('local:getHome', (): IpcResult<string> => {
    return { success: true, data: localFs.getHomePath() }
  })

  // 인자는 신뢰하지 않으므로 unknown으로 받는다. statEntries가 던지지 않아 try/catch는 두지 않는다.
  ipcMain.handle('local:stat', async (_e, paths: unknown): Promise<IpcResult<LocalFileEntry[]>> => {
    if (!Array.isArray(paths)) return { success: false, error: 'paths must be an array' }
    return { success: true, data: await localFs.statEntries(paths) }
  })

  ipcMain.handle('local:getPlaces', async (): Promise<IpcResult<LocalPlaces>> => {
    try {
      const names = ['desktop', 'downloads', 'documents', 'pictures', 'music', 'videos'] as const
      // 드라이브 확인을 먼저 시작해 폴더 확인과 함께 기다린다
      const [roots, folders] = await Promise.all([
        driveRoots(),
        Promise.all(names.map(knownFolder))
      ])
      const [desktop, downloads, documents, pictures, music, videos] = folders
      const home = localFs.getHomePath()
      return {
        success: true,
        data: { home, desktop, downloads, documents, pictures, music, videos, roots }
      }
    } catch (err) {
      return ipcError(err)
    }
  })

  // 렌더러 CSP(img-src 'self' data:)는 file: 이미지를 막으므로 data URL로 준다. MIME은 원격 미리 보기와 같다.
  ipcMain.handle('local:preview', async (_event, filePath: string): Promise<IpcResult<string>> => {
    try {
      // 영상도 같은 data URL 경로로 준다(P3). 게이트는 이미지·영상 둘 다 연다(P5).
      if (!isImageFile(filePath) && !isVideoFile(filePath))
        return { success: false, error: 'Not an image file' }
      // data URL은 파일 전체를 메모리에 올려야 하므로 종류별 상한을 나눈다(P5·함정 D).
      const cap = isVideoFile(filePath) ? MAX_VIDEO_SIZE_BYTES : MAX_IMAGE_SIZE_BYTES
      if ((await stat(filePath)).size > cap) {
        return { success: false, error: 'File too large for preview' }
      }
      const mime = MIME_MAP[extname(filePath).toLowerCase()] || 'image/jpeg'
      const data = (await readFile(filePath)).toString('base64')
      return { success: true, data: `data:${mime};base64,${data}` }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('local:selectDirectory', async (): Promise<IpcResult<string | null>> => {
    try {
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: true, data: null }
      }
      return { success: true, data: result.filePaths[0] }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('local:selectSaveDirectory', async (): Promise<IpcResult<string | null>> => {
    try {
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: true, data: null }
      }
      return { success: true, data: result.filePaths[0] }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle(
    'local:rename',
    async (_event, oldPath: string, newPath: string): Promise<IpcResult<void>> => {
      try {
        await localFs.rename(oldPath, newPath)
        return { success: true, data: undefined }
      } catch (err) {
        return ipcError(err)
      }
    }
  )

  ipcMain.handle('local:mkdir', async (_event, dirPath: string): Promise<IpcResult<void>> => {
    try {
      await localFs.mkdir(dirPath)
      return { success: true, data: undefined }
    } catch (err) {
      return ipcError(err)
    }
  })

  // Expand dropped files/folders into a flat list of files to upload, with
  // POSIX relative paths that preserve folder structure (folders recurse).
  ipcMain.handle(
    'local:expandForUpload',
    async (_event, paths: string[]): Promise<IpcResult<UploadFileEntry[]>> => {
      try {
        const out: UploadFileEntry[] = []
        for (const p of paths) {
          const st = await stat(p)
          const name = basename(p)
          if (st.isDirectory()) {
            const inner = await localFs.collectFiles(p)
            for (const f of inner) {
              out.push({
                localPath: f.abs,
                relativePath: `${name}/${f.rel.split(sep).join('/')}`,
                size: f.size
              })
            }
          } else {
            out.push({ localPath: p, relativePath: name, size: st.size })
          }
        }
        return { success: true, data: out }
      } catch (err) {
        return ipcError(err)
      }
    }
  )

  ipcMain.handle(
    'local:copyFiles',
    async (
      _event,
      sourcePaths: string[],
      destDir: string,
      names?: string[],
      move?: boolean
    ): Promise<IpcResult<void>> => {
      // Flatten sources (recursing into directories) into a file work list so
      // byte-based progress is uniform regardless of folder nesting.
      let work: CopyWorkItem[]
      let emptyDirs: Array<{ src: string; dest: string }>
      try {
        // 충돌 시트의 "둘 다 두기"가 준 대상 이름(D32). 폴더 밖으로 나가는 이름은 받지 않는다.
        const unsafe = names?.find((n) => !isSafeCopyName(n, process.platform))
        if (unsafe !== undefined) throw new Error(`Invalid name: ${unsafe}`)
        work = []
        // 이동에서 빈 폴더 원본은 파일이 없어 작업 목록에 오르지 않으므로 따로 옮긴다(F17).
        emptyDirs = []
        for (const [i, src] of sourcePaths.entries()) {
          const st = await stat(src)
          const name = names?.[i] ?? basename(src)
          if (st.isDirectory()) {
            const inner = await localFs.collectFiles(src)
            const root = resolve(src)
            for (const f of inner) {
              work.push({ src: f.abs, dest: join(destDir, name, f.rel), size: f.size, root })
            }
            if (move && inner.length === 0) emptyDirs.push({ src, dest: join(destDir, name) })
          } else {
            work.push({ src, dest: join(destDir, name), size: st.size })
          }
        }
        // 자기 위에 복사하면 쓰기 스트림이 원본을 먼저 비운다.
        const self = [...work, ...emptyDirs].find((w) => samePath(w.src, w.dest))
        if (self) throw new Error(`Source and destination are the same file: ${self.src}`)
      } catch (err) {
        return ipcError(err)
      }

      const totalBytes = work.reduce((sum, w) => sum + w.size, 0)
      const items = {
        itemCount: sourcePaths.length,
        itemName: sourcePaths.length === 1 ? basename(sourcePaths[0]) : undefined
      }
      const job = operationManager.create('copy', items, 'bytes', totalBytes)

      let copiedBytes = 0
      // 이동이면 파일 하나를 복사한 직후 그 원본을 지운다. 취소·실패해도 아직 복사하지 않은 원본은 남는다(F1).
      const moved: CopyWorkItem[] = []
      try {
        for (const item of work) {
          if (operationManager.isCancelled(job.id)) {
            operationManager.markCancelled(job.id)
            return { success: true, data: undefined }
          }
          await mkdir(dirname(item.dest), { recursive: true })
          await localFs.copyFileWithProgress(
            item.src,
            item.dest,
            (chunkLength) => {
              copiedBytes += chunkLength
              operationManager.progress(job.id, copiedBytes, basename(item.src))
            },
            () => operationManager.isCancelled(job.id)
          )
          if (move) {
            await localFs.delete(item.src, false)
            moved.push(item)
          }
        }
        for (const dir of emptyDirs) {
          await mkdir(dir.dest, { recursive: true })
          await removeIfEmpty(dir.src)
        }
        operationManager.complete(job.id)
        return { success: true, data: undefined }
      } catch (err) {
        if (operationManager.isCancelled(job.id)) {
          operationManager.markCancelled(job.id)
          return { success: true, data: undefined }
        }
        operationManager.fail(job.id, err instanceof Error ? err.message : String(err))
        return ipcError(err)
      } finally {
        await removeEmptiedDirs(moved)
      }
    }
  )

  ipcMain.handle(
    'local:deleteBatch',
    async (_event, targets: DeleteTarget[]): Promise<IpcResult<void>> => {
      const items = {
        itemCount: targets.length,
        itemName: targets.length === 1 ? basename(targets[0].path) : undefined
      }
      const job = operationManager.create('delete', items, 'files', targets.length)

      try {
        for (let i = 0; i < targets.length; i++) {
          if (operationManager.isCancelled(job.id)) {
            operationManager.markCancelled(job.id)
            return { success: true, data: undefined }
          }
          const target = targets[i]
          operationManager.progress(job.id, i, basename(target.path))
          if (target.onlyIfEmpty) await removeIfEmpty(target.path)
          else await localFs.delete(target.path, target.isDirectory)
          operationManager.progress(job.id, i + 1, basename(target.path))
        }
        operationManager.complete(job.id)
        return { success: true, data: undefined }
      } catch (err) {
        operationManager.fail(job.id, err instanceof Error ? err.message : String(err))
        return ipcError(err)
      }
    }
  )

  return localFs
}
