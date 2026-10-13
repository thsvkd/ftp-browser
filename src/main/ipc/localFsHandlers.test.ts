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
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, access: vi.fn(actual.access) }
})

import { access } from 'fs/promises'
import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { isSafeCopyName, registerLocalFsHandlers } from './localFsHandlers'
import type { OperationManager } from '../operation/OperationManager'
import type { IpcResult } from '@shared/types/ipc'
import type { LocalFileEntry, LocalPlaces } from '@shared/types/local'
import { MAX_IMAGE_SIZE_BYTES } from '@shared/constants'

type Handler = (event: unknown, ...args: unknown[]) => Promise<IpcResult<void>>

describe('localFsHandlers', () => {
  let tmpDir: string
  let handlers: Map<string, Handler>

  beforeEach(async () => {
    vi.clearAllMocks()
    const real = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    vi.mocked(access).mockImplementation(real.access)
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
