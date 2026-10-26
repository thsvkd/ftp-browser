import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// localFsHandlers는 electron의 ipcMain/dialog/BrowserWindow를, LocalFileSystem은 app을
// 임포트한다. node 환경에서 모듈이 로드되도록 목으로 세운다. handle은 등록만 기록하고,
// 테스트가 그 핸들러를 꺼내 직접 호출한다.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: class {},
  app: { getPath: vi.fn(() => os.tmpdir()) }
}))
// 드라이브 루트 확인은 fs/promises의 access만 쓴다. 테스트가 드라이브마다 응답을 고른다.
// rmdir은 지울 수 없는 폴더(EPERM)를 흉내 내려고 감싼다.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, access: vi.fn(actual.access), rmdir: vi.fn(actual.rmdir) }
})

import { access, rmdir } from 'fs/promises'
import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { isSafeCopyName, registerLocalFsHandlers } from './localFsHandlers'
import type { OperationManager } from '../operation/OperationManager'
import type { IpcResult } from '@shared/types/ipc'
import type { LocalFileEntry, LocalPlaces } from '@shared/types/local'
import { MAX_IMAGE_SIZE_BYTES, MAX_VIDEO_SIZE_BYTES } from '@shared/constants'

type Handler = (event: unknown, ...args: unknown[]) => Promise<IpcResult<void>>

describe('localFsHandlers', () => {
  let tmpDir: string
  let handlers: Map<string, Handler>

  beforeEach(async () => {
    vi.clearAllMocks()
    const real = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    vi.mocked(access).mockImplementation(real.access)
    vi.mocked(rmdir).mockImplementation(real.rmdir)
    vi.mocked(app.getPath).mockImplementation(() => os.tmpdir())
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lfs-ipc-test-'))

    handlers = new Map()
    vi.mocked(ipcMain.handle).mockImplementation(((channel: string, listener: Handler) => {
      handlers.set(channel, listener)
    }) as unknown as typeof ipcMain.handle)

    // rename/mkdir 핸들러는 operationManager를 쓰지 않는다(진행률 잡을 만들지 않음).
    registerLocalFsHandlers({} as BrowserWindow, {} as OperationManager)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function handler(channel: string): Handler {
    const found = handlers.get(channel)
    if (!found) throw new Error(`No handler registered for "${channel}"`)
    return found
  }

  describe('local:rename', () => {
    it('returns success and renames the file', async () => {
      // covers: Test-92
      const oldPath = path.join(tmpDir, 'before.txt')
      const newPath = path.join(tmpDir, 'after.txt')
      await fs.writeFile(oldPath, 'payload')

      const result = await handler('local:rename')(null, oldPath, newPath)

      expect(result).toEqual({ success: true, data: undefined })
      expect(await fs.readFile(newPath, 'utf8')).toBe('payload')
    })

    it('wraps a rename failure in an ipcError result instead of throwing', async () => {
      // covers: Test-92
      const otherDir = path.join(tmpDir, 'other')
      await fs.mkdir(otherDir)
      const oldPath = path.join(tmpDir, 'stay.txt')
      await fs.writeFile(oldPath, 'payload')

      // 던지지 않고 반환해야 한다. 던지면 렌더러가 reject를 받아 Test-81 경로로 샌다.
      const result = await handler('local:rename')(null, oldPath, path.join(otherDir, 'stay.txt'))

      expect(result.success).toBe(false)
      expect(result).toMatchObject({ error: expect.stringContaining('same directory') })
      // 실패했으므로 원본은 제자리에 남는다.
      expect(await fs.readFile(oldPath, 'utf8')).toBe('payload')
    })
  })

  describe('local:mkdir', () => {
    it('returns success and creates the directory', async () => {
      // covers: Test-92
      const dir = path.join(tmpDir, 'fresh')

      const result = await handler('local:mkdir')(null, dir)

      expect(result).toEqual({ success: true, data: undefined })
      expect((await fs.stat(dir)).isDirectory()).toBe(true)
    })

    it('wraps a mkdir failure in an ipcError result instead of throwing', async () => {
      // covers: Test-92
      const dir = path.join(tmpDir, 'taken')
      await fs.mkdir(dir)

      const result = await handler('local:mkdir')(null, dir)

      expect(result.success).toBe(false)
      expect(result).toMatchObject({ error: expect.any(String) })
      expect((result as { error: string }).error).not.toBe('')
    })
  })

  describe('local:getPlaces', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

    afterEach(() => {
      Object.defineProperty(process, 'platform', platform)
      vi.useRealTimers()
    })

    it('returns the known folders and only the drive roots that answer in time', async () => {
      // covers: Test-768
      const names = ['home', 'desktop', 'downloads', 'documents', 'pictures', 'music', 'videos']
      for (const name of names.filter((n) => n !== 'videos'))
        await fs.mkdir(path.join(tmpDir, name))
      vi.mocked(app.getPath).mockImplementation((name) => {
        if (name === 'music') throw new Error('no music folder')
        return path.join(tmpDir, name)
      })
      const real = await vi.importActual<typeof import('fs/promises')>('fs/promises')
      const drive = /^[A-Z]:\\$/
      vi.mocked(access).mockImplementation(async (p) => {
        if (!drive.test(String(p))) return real.access(p)
        if (p === 'C:\\') return
        // 응답하지 않는 네트워크 드라이브
        if (p === 'D:\\') return new Promise<void>(() => {})
        throw Object.assign(new Error('no drive'), { code: 'ENOENT' })
      })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

      const pending = handler('local:getPlaces')(null) as unknown as Promise<IpcResult<LocalPlaces>>
      await vi.advanceTimersByTimeAsync(1000)
      const win = await pending

      expect(win).toEqual({
        success: true,
        data: {
          home: path.join(tmpDir, 'home'),
          desktop: path.join(tmpDir, 'desktop'),
          downloads: path.join(tmpDir, 'downloads'),
          documents: path.join(tmpDir, 'documents'),
          pictures: path.join(tmpDir, 'pictures'),
          music: null,
          videos: null,
          roots: ['C:\\']
        }
      })
      const probed = vi
        .mocked(access)
        .mock.calls.map(([p]) => String(p))
        .filter((p) => drive.test(p))
      expect(probed).toHaveLength(26)

      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      vi.mocked(access).mockClear()
      const other = (await handler('local:getPlaces')(null)) as unknown as IpcResult<LocalPlaces>
      expect(other).toMatchObject({ success: true, data: { roots: ['/'] } })
      expect(vi.mocked(access).mock.calls.some(([p]) => drive.test(String(p)))).toBe(false)
    })
  })

  describe('local:preview', () => {
    it('returns an image as a data URL and refuses large or non-image files', async () => {
      // covers: Test-769
      const png = path.join(tmpDir, 'a.PNG')
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
      await fs.writeFile(png, bytes)
      const big = path.join(tmpDir, 'big.jpg')
      await fs.writeFile(big, '')
      await fs.truncate(big, MAX_IMAGE_SIZE_BYTES + 1)
      const text = path.join(tmpDir, 'a.txt')
      await fs.writeFile(text, 'hello')

      const ok = await handler('local:preview')(null, png)

      expect(ok).toEqual({
        success: true,
        data: `data:image/png;base64,${bytes.toString('base64')}`
      })
      for (const p of [big, text, path.join(tmpDir, 'missing.jpg')]) {
        expect(await handler('local:preview')(null, p)).toMatchObject({
          success: false,
          error: expect.any(String)
        })
      }
    })

    it('returns a webm as a data:video/webm URL', async () => {
      // covers: Test-1203
      const webm = path.join(tmpDir, 'clip.webm')
      const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 9, 8])
      await fs.writeFile(webm, bytes)

      const result = await handler('local:preview')(null, webm)

      expect(result).toEqual({
        success: true,
        data: `data:video/webm;base64,${bytes.toString('base64')}`
      })
    })

    it('caps videos at MAX_VIDEO_SIZE_BYTES and images at MAX_IMAGE_SIZE_BYTES', async () => {
      // covers: Test-1204
      const bigVideo = path.join(tmpDir, 'big.webm')
      await fs.writeFile(bigVideo, '')
      await fs.truncate(bigVideo, MAX_VIDEO_SIZE_BYTES + 1)
      const bigImage = path.join(tmpDir, 'big.jpg')
      await fs.writeFile(bigImage, '')
      await fs.truncate(bigImage, MAX_IMAGE_SIZE_BYTES + 1)
      // 이미지 상한(50MB)과 영상 상한(100MB)은 다르다. 두 상한을 하나로 합치면 이 중 하나가 깨진다.
      const midVideo = path.join(tmpDir, 'mid.mp4')
      await fs.writeFile(midVideo, '')
      await fs.truncate(midVideo, MAX_IMAGE_SIZE_BYTES + 1)

      for (const p of [bigVideo, bigImage]) {
        expect(await handler('local:preview')(null, p)).toEqual({
          success: false,
          error: 'File too large for preview'
        })
      }
      const mid = await handler('local:preview')(null, midVideo)
      expect(mid).toMatchObject({
        success: true,
        data: expect.stringContaining('data:video/mp4;base64,')
      })
    })
  })

  describe('local:copyFiles', () => {
    it('copies each source under the given name and refuses unsafe names before copying', async () => {
      // covers: Test-841
      const ops = {
        create: vi.fn(() => ({ id: 'op1' })),
        isCancelled: vi.fn(() => false),
        progress: vi.fn(),
        complete: vi.fn(),
        fail: vi.fn(),
        markCancelled: vi.fn()
      }
      registerLocalFsHandlers({} as BrowserWindow, ops as unknown as OperationManager)
      const src = path.join(tmpDir, 'src')
      const dest = path.join(tmpDir, 'dest')
      await fs.mkdir(path.join(src, 'dir'), { recursive: true })
      await fs.mkdir(dest)
      await fs.writeFile(path.join(src, 'a.txt'), 'A')
      await fs.writeFile(path.join(src, 'dir', 'b.txt'), 'B')
      const sources = [path.join(src, 'a.txt'), path.join(src, 'dir')]

      const ok = await handler('local:copyFiles')(null, sources, dest, ['a (1).txt', 'dir (1)'])

      expect(ok).toEqual({ success: true, data: undefined })
      expect(await fs.readFile(path.join(dest, 'a (1).txt'), 'utf8')).toBe('A')
      expect(await fs.readFile(path.join(dest, 'dir (1)', 'b.txt'), 'utf8')).toBe('B')

      for (const bad of ['..', `..${path.sep}x`, 'a/b', '']) {
        const r = await handler('local:copyFiles')(null, sources, dest, ['ok.txt', bad])
        expect(r).toMatchObject({ success: false, error: expect.any(String) })
      }
      expect(await fs.readdir(dest)).toEqual(['a (1).txt', 'dir (1)'])
    })

    it('refuses to copy a file onto itself, case-folded on Windows and macOS', async () => {
      // covers: Test-841
      registerLocalFsHandlers(
        {} as BrowserWindow,
        {
          create: vi.fn(() => ({ id: 'op1' })),
          isCancelled: vi.fn(() => false),
          progress: vi.fn(),
          complete: vi.fn(),
          fail: vi.fn(),
          markCancelled: vi.fn()
        } as unknown as OperationManager
      )
      const file = path.join(tmpDir, 'a.txt')
      await fs.writeFile(file, 'keep me')
      const same = ['a.txt']
      if (process.platform === 'win32' || process.platform === 'darwin') same.push('A.TXT')
      for (const name of same) {
        const r = await handler('local:copyFiles')(null, [file], tmpDir, [name])
        expect(r).toMatchObject({ success: false, error: expect.any(String) })
      }
      expect(await fs.readFile(file, 'utf8')).toBe('keep me')
    })

    it('checks copy names by the platform rule', () => {
      // covers: Test-841
      for (const name of ['a b.txt', 'report 10:30.txt', 'a\\b']) {
        expect(isSafeCopyName(name, 'linux')).toBe(true)
        expect(isSafeCopyName(name, 'darwin')).toBe(true)
      }
      expect(isSafeCopyName('a b.txt', 'win32')).toBe(true)
      for (const name of ['report 10:30.txt', 'a\\b'])
        expect(isSafeCopyName(name, 'win32')).toBe(false)
      for (const name of ['', '.', '..', 'a/b'])
        for (const platform of ['win32', 'linux', 'darwin'])
          expect(isSafeCopyName(name, platform)).toBe(false)
    })

    /** 진행률을 처음 받은 뒤로 취소된 것으로 답하는 작업 관리자(`cancelAfterFirst`가 false면 취소 없음). */
    function operations(cancelAfterFirst: boolean): OperationManager {
      let cancelled = false
      return {
        create: vi.fn(() => ({ id: 'op1' })),
        isCancelled: vi.fn(() => cancelled),
        progress: vi.fn(() => {
          cancelled = cancelAfterFirst
        }),
        complete: vi.fn(),
        fail: vi.fn(),
        markCancelled: vi.fn()
      } as unknown as OperationManager
    }

    const exists = (p: string): Promise<boolean> =>
      fs.access(p).then(
        () => true,
        () => false
      )

    it('keeps every source file not yet copied when a move is cancelled mid-way', async () => {
      // covers: Test-1267
      registerLocalFsHandlers({} as BrowserWindow, operations(true))
      const folder = path.join(tmpDir, 'src', 'folder')
      const dest = path.join(tmpDir, 'dest')
      await fs.mkdir(folder, { recursive: true })
      await fs.mkdir(dest)
      await fs.writeFile(path.join(folder, 'a.txt'), 'A')
      await fs.writeFile(path.join(folder, 'b.txt'), 'B')

      const r = await handler('local:copyFiles')(null, [folder], dest, ['folder'], true)

      expect(r.success).toBe(true)
      const moved: string[] = []
      const kept: string[] = []
      for (const name of ['a.txt', 'b.txt']) {
        const atSource = await exists(path.join(folder, name))
        const atDest = await exists(path.join(dest, 'folder', name))
        // 한 파일은 옮겨졌고(원본 없음·대상 있음), 다른 파일은 원본에 그대로다(대상 없음).
        expect(atSource).not.toBe(atDest)
        ;(atSource ? kept : moved).push(name)
      }
      expect(moved).toHaveLength(1)
      expect(kept).toHaveLength(1)
      expect(await fs.readFile(path.join(folder, kept[0]), 'utf8')).toBe(kept[0][0].toUpperCase())
    })

    it('removes moved source files and the folders they emptied, keeping folders with other entries', async () => {
      // covers: Test-1268
      registerLocalFsHandlers({} as BrowserWindow, operations(false))
      const src = path.join(tmpDir, 'src')
      const dest = path.join(tmpDir, 'dest')
      const kept = path.join(src, 'kept')
      const gone = path.join(src, 'gone')
      await fs.mkdir(path.join(kept, 'sub'), { recursive: true })
      await fs.mkdir(path.join(kept, 'empty'))
      await fs.mkdir(path.join(gone, 'deep'), { recursive: true })
      await fs.mkdir(dest)
      await fs.writeFile(path.join(kept, 'a.txt'), 'A')
      await fs.writeFile(path.join(kept, 'sub', 'b.txt'), 'B')
      await fs.writeFile(path.join(gone, 'deep', 'c.txt'), 'C')
      await fs.writeFile(path.join(src, 'f.txt'), 'F')

      const r = await handler('local:copyFiles')(
        null,
        [kept, gone, path.join(src, 'f.txt')],
        dest,
        ['kept', 'gone', 'f.txt'],
        true
      )

      expect(r).toEqual({ success: true, data: undefined })
      expect(await fs.readFile(path.join(dest, 'kept', 'sub', 'b.txt'), 'utf8')).toBe('B')
      expect(await fs.readFile(path.join(dest, 'gone', 'deep', 'c.txt'), 'utf8')).toBe('C')
      expect(await fs.readFile(path.join(dest, 'f.txt'), 'utf8')).toBe('F')
      // 옮긴 파일과 비게 된 폴더는 사라진다
      for (const p of [
        path.join(kept, 'a.txt'),
        path.join(kept, 'sub'),
        gone,
        path.join(src, 'f.txt')
      ])
        expect(await exists(p), p).toBe(false)
      // 복사 대상이 아니던 빈 하위 폴더와 그 상위 폴더는 남는다
      expect(await fs.readdir(kept)).toEqual(['empty'])
      expect(await fs.readdir(src)).toEqual(['kept'])
    })

    it('moves an empty source folder as an empty folder of the same name', async () => {
      // covers: Test-1303
      registerLocalFsHandlers({} as BrowserWindow, operations(false))
      const empty = path.join(tmpDir, 'src', 'empty')
      const dest = path.join(tmpDir, 'dest')
      await fs.mkdir(empty, { recursive: true })
      await fs.mkdir(dest)

      const r = await handler('local:copyFiles')(null, [empty], dest, ['moved'], true)

      expect(r).toEqual({ success: true, data: undefined })
      expect(await fs.readdir(path.join(dest, 'moved'))).toEqual([])
      expect(await exists(empty)).toBe(false)
    })

    it('copies (not moves) an empty source folder exactly as before', async () => {
      // covers: Test-1303
      registerLocalFsHandlers({} as BrowserWindow, operations(false))
      const empty = path.join(tmpDir, 'src', 'empty')
      const dest = path.join(tmpDir, 'dest')
      await fs.mkdir(empty, { recursive: true })
      await fs.mkdir(dest)

      const r = await handler('local:copyFiles')(null, [empty], dest, ['moved'])

      expect(r).toEqual({ success: true, data: undefined })
      expect(await exists(empty)).toBe(true)
      expect(await fs.readdir(dest)).toEqual([])
    })

    it('removes emptied nested folders deepest first up to the source folder, not its parent', async () => {
      // covers: Test-1304
      registerLocalFsHandlers({} as BrowserWindow, operations(false))
      const parent = path.join(tmpDir, 'src')
      const a = path.join(parent, 'a')
      const dest = path.join(tmpDir, 'dest')
      await fs.mkdir(path.join(a, 'b', 'c'), { recursive: true })
      await fs.mkdir(dest)
      // a/b의 파일이 a/b/c의 파일보다 먼저 옮겨지므로 얕은 폴더가 먼저 후보에 오른다
      await fs.writeFile(path.join(a, 'b', '0.txt'), '0')
      await fs.writeFile(path.join(a, 'b', 'c', 'x.txt'), 'X')

      const r = await handler('local:copyFiles')(null, [a], dest, ['a'], true)

      expect(r).toEqual({ success: true, data: undefined })
      expect(await fs.readFile(path.join(dest, 'a', 'b', '0.txt'), 'utf8')).toBe('0')
      expect(await fs.readFile(path.join(dest, 'a', 'b', 'c', 'x.txt'), 'utf8')).toBe('X')
      expect(await exists(a)).toBe(false)
      expect(await fs.readdir(parent)).toEqual([])
    })
  })

  describe('local:deleteBatch', () => {
    it('leaves a folder marked only-if-empty that is not empty, without reporting a failure', async () => {
      // covers: Test-1271
      const ops = {
        create: vi.fn(() => ({ id: 'op1' })),
        isCancelled: vi.fn(() => false),
        progress: vi.fn(),
        complete: vi.fn(),
        fail: vi.fn(),
        markCancelled: vi.fn()
      }
      registerLocalFsHandlers({} as BrowserWindow, ops as unknown as OperationManager)
      const full = path.join(tmpDir, 'full')
      const empty = path.join(tmpDir, 'empty')
      await fs.mkdir(full)
      await fs.mkdir(empty)
      await fs.writeFile(path.join(full, 'keep.txt'), 'keep')

      const r = await handler('local:deleteBatch')(null, [
        { path: full, isDirectory: true, onlyIfEmpty: true },
        { path: empty, isDirectory: true, onlyIfEmpty: true }
      ])

      expect(r).toEqual({ success: true, data: undefined })
      expect(await fs.readFile(path.join(full, 'keep.txt'), 'utf8')).toBe('keep')
      expect(await fs.readdir(tmpDir)).toEqual(['full'])
      expect(ops.fail).not.toHaveBeenCalled()
    })

    it('does not fail the batch when an only-if-empty folder is missing or cannot be removed', async () => {
      // covers: Test-1302
      const ops = {
        create: vi.fn(() => ({ id: 'op1' })),
        isCancelled: vi.fn(() => false),
        progress: vi.fn(),
        complete: vi.fn(),
        fail: vi.fn(),
        markCancelled: vi.fn()
      }
      registerLocalFsHandlers({} as BrowserWindow, ops as unknown as OperationManager)
      const locked = path.join(tmpDir, 'locked')
      const file = path.join(tmpDir, 'f.txt')
      await fs.mkdir(locked)
      await fs.writeFile(file, 'F')
      vi.mocked(rmdir).mockRejectedValueOnce(
        Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      )

      const r = await handler('local:deleteBatch')(null, [
        { path: locked, isDirectory: true, onlyIfEmpty: true },
        { path: path.join(tmpDir, 'gone'), isDirectory: true, onlyIfEmpty: true },
        { path: file, isDirectory: false }
      ])

      expect(r).toEqual({ success: true, data: undefined })
      expect(await fs.readdir(tmpDir)).toEqual(['locked'])
      expect(ops.fail).not.toHaveBeenCalled()
      expect(ops.complete).toHaveBeenCalled()
    })
  })

  describe('local:stat', () => {
    it('stats paths into LocalFileEntry items, skipping unreadable ones, and rejects non-arrays as a value', async () => {
      // covers: Test-872
      const file = path.join(tmpDir, 'a.txt')
      await fs.writeFile(file, 'hello')

      const result = (await handler('local:stat')(null, [
        file,
        path.join(tmpDir, 'nope')
      ])) as unknown as IpcResult<LocalFileEntry[]> & { success: true }

      expect(result.success).toBe(true)
      expect(result.data).toHaveLength(1)
      expect(result.data[0]).toMatchObject({ path: file, name: 'a.txt', type: 'file', size: 5 })
      expect(await handler('local:stat')(null, 'x')).toEqual({
        success: false,
        error: 'paths must be an array'
      })
    })
  })
})
