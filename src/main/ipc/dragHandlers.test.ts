import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
let tempRoot = ''

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  },
  app: { getPath: () => tempRoot, on: vi.fn() },
  nativeImage: { createFromBuffer: () => ({}) }
}))

import { registerDragHandlers } from './dragHandlers'
import { ConnectionRegistry } from '../ftp/ConnectionRegistry'
import { fakeSession, payloadOf, remoteOf } from '../ftp/__fixtures__/fakeSessions'
import type { IpcResult } from '@shared/types/ipc'

const K = 'me@nas.local:21'

// 렌더러가 이미 이름을 고쳐 보내더라도, 디스크에 쓰는 쪽은 메인 프로세스다. 원격 이름이
// 임시 폴더 밖을 가리키면 다운로드 자체를 하지 않아야 한다(심층 방어).
describe('drag:start', () => {
  let downloadTo: ReturnType<typeof vi.fn>
  let startDrag: ReturnType<typeof vi.fn>
  let dragDir: string

  async function start(fileNames: string[]): Promise<IpcResult<void>> {
    const files = fileNames.map((fileName) => ({
      remotePath: `/srv/${fileName}`,
      fileName,
      size: 1
    }))
    return (await handlers.get('drag:start')!({ sender: { startDrag } }, K, {
      files
    })) as IpcResult<void>
  }

  beforeEach(async () => {
    handlers.clear()
    tempRoot = mkdtempSync(join(tmpdir(), 'drag-test-'))
    dragDir = join(tempRoot, 'ftp-browser-drag')
    downloadTo = vi.fn().mockResolvedValue(undefined)
    startDrag = vi.fn()
    const registry = new ConnectionRegistry((key) => {
      const session = fakeSession(key)
      Object.assign(remoteOf(session), {
        createSecondaryClient: vi.fn().mockResolvedValue({ downloadTo, close: vi.fn() })
      })
      return session
    })
    await registry.connect(payloadOf(K))
    registerDragHandlers(registry)
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('writes every file directly inside the drag folder under a local-safe name', async () => {
    const result = await start(['ok.txt', 'a/../../escape'])

    expect(result.success).toBe(true)
    const written = downloadTo.mock.calls.map((call) => call[0] as string)
    expect(written).toEqual([join(dragDir, 'ok.txt'), join(dragDir, 'a_.._.._escape')])
    for (const path of written) expect(dirname(path)).toBe(dragDir)
    expect(startDrag).toHaveBeenCalledWith(expect.objectContaining({ files: written }))
  })

  it('numbers names that collide once sanitised instead of overwriting one', async () => {
    const result = await start(['a/b.txt', 'a_b.txt'])

    expect(result.success).toBe(true)
    const written = downloadTo.mock.calls.map((call) => call[0] as string)
    expect(written).toEqual([join(dragDir, 'a_b.txt'), join(dragDir, 'a_b (1).txt')])
  })

  it('keeps a genuine name that a sanitised name would otherwise be numbered into', async () => {
    const result = await start(['a_b.txt', 'a/b.txt', 'a_b (1).txt'])

    expect(result.success).toBe(true)
    const written = downloadTo.mock.calls.map((call) => call[0] as string)
    expect(written).toEqual([
      join(dragDir, 'a_b.txt'),
      join(dragDir, 'a_b (2).txt'),
      join(dragDir, 'a_b (1).txt')
    ])
  })

  it('refuses the whole drag when a name cannot be saved locally', async () => {
    const result = await start(['ok.txt', '..'])

    expect(result).toMatchObject({ success: false })
    expect(result.success === false && result.error).toContain('..')
    // 일부만 받은 채 끌기를 시작하지 않도록, 이름 검사는 다운로드보다 먼저 한다.
    expect(downloadTo).not.toHaveBeenCalled()
    expect(startDrag).not.toHaveBeenCalled()
  })
})

describe('drag:start with two connections', () => {
  beforeEach(() => {
    handlers.clear()
    tempRoot = mkdtempSync(join(tmpdir(), 'drag-test-'))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('downloads through the secondary client of the connection it names', async () => {
    // covers: Test-973
    const A = 'u1@nas.local:21'
    const B = 'u2@nas.local:21'
    const secondary = new Map<string, ReturnType<typeof vi.fn>>()
    const registry = new ConnectionRegistry((key) => {
      const session = fakeSession(key)
      const create = vi.fn().mockResolvedValue({
        downloadTo: vi.fn().mockResolvedValue(undefined),
        close: vi.fn()
      })
      secondary.set(key, create)
      Object.assign(remoteOf(session), { createSecondaryClient: create })
      return session
    })
    await registry.connect(payloadOf(A))
    await registry.connect(payloadOf(B))
    registerDragHandlers(registry)

    const result = (await handlers.get('drag:start')!({ sender: { startDrag: vi.fn() } }, B, {
      files: [{ remotePath: '/srv/a.jpg', fileName: 'a.jpg', size: 1 }]
    })) as IpcResult<void>

    expect(result.success).toBe(true)
    expect(secondary.get(B)).toHaveBeenCalled()
    expect(secondary.get(A)).not.toHaveBeenCalled()
  })
})
