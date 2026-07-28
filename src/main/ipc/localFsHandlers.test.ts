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

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { registerLocalFsHandlers } from './localFsHandlers'
import type { OperationManager } from '../operation/OperationManager'
import type { IpcResult } from '@shared/types/ipc'

type Handler = (event: unknown, ...args: unknown[]) => Promise<IpcResult<void>>

describe('localFsHandlers', () => {
  let tmpDir: string
  let handlers: Map<string, Handler>

  beforeEach(async () => {
    vi.clearAllMocks()
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
})
