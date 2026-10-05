import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// LocalFileSystem은 getHomePath() 때문에 electron app을 임포트한다
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => os.tmpdir()) } }))

import { LocalFileSystem } from '../../local/LocalFileSystem'
import { createAgentServices } from './index'
import { createHarness, type Harness } from './__fixtures__/fakes'
import { MAX_PLAN_ITEMS, type AgentServices, type UploadPlan } from '../types'

let h: Harness
let services: AgentServices
let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-transfers-'))
  h = createHarness({ localFs: new LocalFileSystem() })
  services = createAgentServices(h.deps)
})

afterEach(async () => {
  h.db.close()
  await fs.rm(tmp, { recursive: true, force: true })
})

const at = (...parts: string[]): string => path.join(tmp, ...parts)

describe('transfers.planDownload', () => {
  it('walks remote folders, lists folders to create parents first and skips unusable names', async () => {
    // covers: Test-406
    h = createHarness({ localFs: new LocalFileSystem(), platform: 'win32' })
    services = createAgentServices(h.deps)
    h.remote
      .addDir('/photos')
      .addFile('/photos/a.jpg', 10)
      .addDir('/photos/sub')
      .addFile('/photos/sub/b.jpg', 20)
      .addDir('/photos/sub/deeper')
      .addFile('/photos/sub/deeper/c.jpg', 30)
      .addFile('/photos/...', 5)
      .addLink('/photos/link')
      .addDir('/photos/empty')
      .addFile('/top:1.txt', 1)

    const plan = await services.transfers.planDownload(['/photos', '/top:1.txt'], at('dl'), 'skip')

    expect(plan.createDirs).toEqual([
      at('dl'),
      at('dl', 'photos'),
      at('dl', 'photos', 'sub'),
      at('dl', 'photos', 'sub', 'deeper'),
      at('dl', 'photos', 'empty')
    ])
    expect(plan.items).toEqual([
      { remotePath: '/photos/a.jpg', localPath: at('dl', 'photos', 'a.jpg'), size: 10 },
      { remotePath: '/photos/sub/b.jpg', localPath: at('dl', 'photos', 'sub', 'b.jpg'), size: 20 },
      {
        remotePath: '/photos/sub/deeper/c.jpg',
        localPath: at('dl', 'photos', 'sub', 'deeper', 'c.jpg'),
        size: 30
      },
      // Windows에서 쓸 수 없는 ':'는 '_'로 바꾼다(toLocalFileName)
      { remotePath: '/top:1.txt', localPath: at('dl', 'top_1.txt'), size: 1 }
    ])
    expect(plan.skipped).toEqual([
      { remotePath: '/photos/...', reason: expect.any(String) },
      { remotePath: '/photos/link', reason: expect.any(String) }
    ])
    expect(plan.totalBytes).toBe(61)
    // 계획은 아무것도 만들지 않는다
    await expect(fs.stat(at('dl'))).rejects.toThrow()
  })

  it('skips or renames around existing local files and never plans to write one', async () => {
    // covers: Test-407
    await fs.writeFile(at('a.txt'), 'mine')
    await fs.writeFile(at('a (1).txt'), 'mine too')
    await fs.mkdir(at('photos'))
    await fs.writeFile(at('photos', 'b.txt'), 'mine')
    await fs.writeFile(at('docs'), 'a file where the remote has a folder')
    h.remote
      .addFile('/a.txt')
      .addFile('/c.txt')
      .addDir('/photos')
      .addFile('/photos/b.txt')
      .addFile('/photos/d.txt')
      .addDir('/docs')
      .addFile('/docs/x.txt')
    const sources = ['/a.txt', '/c.txt', '/photos', '/docs']
    const existing = [at('a.txt'), at('a (1).txt'), at('photos', 'b.txt'), at('docs')]

    const skip = await services.transfers.planDownload(sources, tmp, 'skip')
    expect(skip.items.map((i) => i.localPath)).toEqual([at('c.txt'), at('photos', 'd.txt')])
    expect(skip.skipped.map((s) => s.remotePath)).toEqual(['/a.txt', '/photos/b.txt', '/docs'])
    expect(skip.createDirs).toEqual([])

    const rename = await services.transfers.planDownload(sources, tmp, 'rename')
    expect(rename.items.map((i) => [i.remotePath, i.localPath])).toEqual([
      ['/a.txt', at('a (2).txt')],
      ['/c.txt', at('c.txt')],
      ['/photos/b.txt', at('photos', 'b (1).txt')],
      ['/photos/d.txt', at('photos', 'd.txt')],
      ['/docs/x.txt', at('docs (1)', 'x.txt')]
    ])
    expect(rename.createDirs).toEqual([at('docs (1)')])
    expect(rename.skipped).toEqual([])

    for (const plan of [skip, rename]) {
      for (const item of plan.items) expect(existing).not.toContain(item.localPath)
    }
  })

  it('never targets a file that appeared after planning or is already being downloaded', async () => {
    // covers: Test-416
    h.remote.addFile('/a.txt').addFile('/b.txt').addFile('/c.txt').addDir('/new')
    h.remote.addFile('/new/n.txt')
    h.queue.add({ direction: 'download', localPath: at('c.txt'), status: 'pending' })

    const skip = await services.transfers.planDownload(['/c.txt'], tmp, 'skip')
    expect(skip.items).toEqual([])
    const rename = await services.transfers.planDownload(['/c.txt'], tmp, 'rename')
    expect(rename.items.map((i) => i.localPath)).toEqual([at('c (1).txt')])

    const plan = await services.transfers.planDownload(['/a.txt', '/b.txt', '/new'], tmp, 'skip')
    await fs.writeFile(at('a.txt'), 'appeared meanwhile')
    const ids = services.transfers.startDownload(plan)

    expect(ids).toHaveLength(2)
    expect(h.queue.enqueueBatch).toHaveBeenLastCalledWith(
      'download',
      [
        { remotePath: '/b.txt', localPath: at('b.txt'), fileName: 'b.txt', totalBytes: 1 },
        {
          remotePath: '/new/n.txt',
          localPath: at('new', 'n.txt'),
          fileName: 'n.txt',
          totalBytes: 1
        }
      ],
      true
    )
    expect(await fs.readFile(at('a.txt'), 'utf8')).toBe('appeared meanwhile')
    expect((await fs.stat(at('new'))).isDirectory()).toBe(true)
    expect(h.events.localChanged).toHaveBeenCalledWith({ paths: [at('new')] })
  })
})

describe('transfers.planUpload', () => {
  it('expands local folders, lists remote folders to create and flags overwrites', async () => {
    // covers: Test-408
    await fs.mkdir(at('album', 'sub'), { recursive: true })
    await fs.writeFile(at('album', 'a.jpg'), 'aa')
    await fs.writeFile(at('album', 'sub', 'b.jpg'), 'bbb')
    await fs.writeFile(at('top.txt'), 't')
    h.remote
      .addDir('/dest')
      .addFile('/dest/top.txt')
      .addDir('/dest/album')
      .addFile('/dest/album/a.jpg')
      .addDir('/empty')
    const sources = [at('album'), at('top.txt')]
    const sorted = (plan: UploadPlan): UploadPlan['items'] =>
      [...plan.items].sort((a, b) => a.remotePath.localeCompare(b.remotePath))

    const skip = await services.transfers.planUpload(sources, '/dest', 'skip')
    expect(skip.items).toEqual([
      {
        localPath: at('album', 'sub', 'b.jpg'),
        remotePath: '/dest/album/sub/b.jpg',
        size: 3,
        overwrites: false
      }
    ])
    expect(skip.skipped.map((s) => s.localPath).sort()).toEqual([
      at('album', 'a.jpg'),
      at('top.txt')
    ])
    expect(skip.remoteDirs).toEqual(['/dest/album/sub'])

    const overwrite = await services.transfers.planUpload(sources, '/dest', 'overwrite')
    expect(sorted(overwrite)).toEqual([
      {
        localPath: at('album', 'a.jpg'),
        remotePath: '/dest/album/a.jpg',
        size: 2,
        overwrites: true
      },
      {
        localPath: at('album', 'sub', 'b.jpg'),
        remotePath: '/dest/album/sub/b.jpg',
        size: 3,
        overwrites: false
      },
      { localPath: at('top.txt'), remotePath: '/dest/top.txt', size: 1, overwrites: true }
    ])
    expect(overwrite.skipped).toEqual([])
    expect(overwrite.totalBytes).toBe(6)

    const fresh = await services.transfers.planUpload([at('album')], '/empty', 'skip')
    expect(fresh.remoteDirs).toEqual(['/empty/album', '/empty/album/sub'])
    expect(fresh.items.every((i) => !i.overwrites)).toBe(true)

    const ids = services.transfers.startUpload(fresh)
    expect(ids).toHaveLength(2)
    expect(h.queue.enqueueBatch).toHaveBeenCalledWith(
      'upload',
      expect.arrayContaining([
        {
          localPath: at('album', 'a.jpg'),
          remotePath: '/empty/album/a.jpg',
          fileName: 'a.jpg',
          totalBytes: 2
        }
      ]),
      true,
      ['/empty/album', '/empty/album/sub']
    )
  })
})

describe('plan size limit', () => {
  it('refuses plans with more than MAX_PLAN_ITEMS files', async () => {
    // covers: Test-409
    h.remote.addDir('/big')
    for (let i = 0; i <= MAX_PLAN_ITEMS; i++) h.remote.addFile(`/big/${i}.jpg`)

    await expect(services.transfers.planDownload(['/big'], tmp, 'skip')).rejects.toMatchObject({
      code: 'TOO_MANY_ITEMS'
    })
    await expect(services.remote.planDelete(['/big'])).rejects.toMatchObject({
      code: 'TOO_MANY_ITEMS'
    })

    const many = Array.from({ length: MAX_PLAN_ITEMS + 1 }, (_, i) => ({
      abs: at('dir', `${i}`),
      rel: `${i}`,
      size: 1
    }))
    h.deps.localFs.collectFiles = vi.fn().mockResolvedValue(many)
    await expect(services.transfers.planUpload([tmp], '/big', 'skip')).rejects.toMatchObject({
      code: 'TOO_MANY_ITEMS'
    })
  })
})
