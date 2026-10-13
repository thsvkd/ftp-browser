import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// LocalFileSystem은 getHomePath() 때문에 electron app을 임포트한다
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => os.tmpdir()) } }))

import { LocalFileSystem } from '../local/LocalFileSystem'
import { FakeRemote } from '../mcp/__fixtures__/agentHarness'
import type { ConflictDecision } from '@shared/types/transfer'
import {
  planDownload,
  planRelay,
  planUpload,
  resolvePlan,
  type FolderPlan,
  type PlanDeps
} from './folderPlan'

let tmp: string
let remote: FakeRemote

const at = (...parts: string[]): string => path.join(tmp, ...parts)

function deps(platform = 'linux'): PlanDeps {
  const localFs = new LocalFileSystem()
  return {
    list: (dir) => remote.list(dir),
    collectFiles: (dir) => localFs.collectFiles(dir),
    platform
  }
}

/** 로컬 파일을 만들고 수정 시각을 정한다 */
async function localFile(p: string, body: string, mtime?: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, body)
  if (mtime) await fs.utimes(p, new Date(mtime), new Date(mtime))
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-plan-'))
  remote = new FakeRemote()
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('planDownload', () => {
  it('expands a remote tree into local items and lists the local folders to create', async () => {
    // covers: Test-753
    remote
      .addDir('/photos')
      .addFile('/photos/a.jpg', 10)
      .addDir('/photos/sub')
      .addFile('/photos/sub/b.jpg', 20)
      .addDir('/photos/empty')
      .addFile('/photos/...', 5)
      .addLink('/photos/link')

    const plan = await planDownload(deps('win32'), ['/photos'], at('dl'))

    expect(plan.items).toEqual([
      {
        remotePath: '/photos/a.jpg',
        localPath: at('dl', 'photos', 'a.jpg'),
        fileName: 'a.jpg',
        totalBytes: 10
      },
      {
        remotePath: '/photos/sub/b.jpg',
        localPath: at('dl', 'photos', 'sub', 'b.jpg'),
        fileName: 'b.jpg',
        totalBytes: 20
      }
    ])
    expect(plan.dirs.sort()).toEqual(
      [at('dl'), at('dl', 'photos'), at('dl', 'photos', 'sub'), at('dl', 'photos', 'empty')].sort()
    )
    expect(plan.skipped).toEqual([
      { path: '/photos/...', reason: 'the name cannot be used on this computer' },
      { path: '/photos/link', reason: 'symbolic link' }
    ])
    expect(plan.totalBytes).toBe(30)
    expect(plan.conflicts).toEqual([])
    // 계획은 디스크를 건드리지 않는다
    await expect(fs.stat(at('dl'))).rejects.toThrow()
  })

  it('turns an existing local file into a conflict and merges into an existing local folder', async () => {
    // covers: Test-754
    await localFile(at('a.jpg'), 'mine', '2026-01-01T00:00:00.000Z')
    await fs.mkdir(at('photos'))
    remote
      .addFile('/a.jpg', 10, '2026-02-01T00:00:00.000Z')
      .addDir('/photos')
      .addFile('/photos/b.jpg', 20)

    const plan = await planDownload(deps(), ['/a.jpg', '/photos'], tmp)

    expect(plan.items.map((i) => i.localPath)).toEqual([at('photos', 'b.jpg')])
    expect(plan.dirs).toEqual([])
    expect(plan.skipped).toEqual([])
    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        target: at('a.jpg'),
        source: '/a.jpg',
        name: 'a.jpg',
        incoming: { size: 10, modifiedAt: '2026-02-01T00:00:00.000Z' },
        existing: { size: 4, modifiedAt: '2026-01-01T00:00:00.000Z' },
        item: { remotePath: '/a.jpg', localPath: at('a.jpg'), fileName: 'a.jpg', totalBytes: 10 },
        renameTo: 'a (1).jpg'
      })
    ])
  })
})

describe('planUpload', () => {
  it('turns an existing remote file into a conflict and skips the other clashes as before', async () => {
    // covers: Test-755
    await localFile(at('src', 'a.jpg'), 'aa', '2026-03-01T00:00:00.000Z')
    await localFile(at('src', 'docs'), 'a file where the server has a folder')
    await localFile(at('src', 'album', 'x.jpg'), 'x')
    await localFile(at('other', 'a.jpg'), 'again')
    remote
      .addDir('/dest')
      .addFile('/dest/a.jpg', 7, '2026-01-01T00:00:00.000Z')
      .addDir('/dest/docs')
      .addFile('/dest/album')

    const plan = await planUpload(
      deps(),
      [at('src', 'a.jpg'), at('src', 'docs'), at('src', 'album'), at('other', 'a.jpg')],
      '/dest'
    )

    expect(plan.items).toEqual([])
    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        target: '/dest/a.jpg',
        source: at('src', 'a.jpg'),
        name: 'a.jpg',
        incoming: { size: 2, modifiedAt: '2026-03-01T00:00:00.000Z' },
        existing: { size: 7, modifiedAt: '2026-01-01T00:00:00.000Z' },
        renameTo: 'a (1).jpg'
      })
    ])
    expect(plan.skipped).toEqual([
      { path: at('src', 'docs'), reason: 'a folder with that name exists on the server' },
      {
        path: at('src', 'album', 'x.jpg'),
        reason: 'a file on the server is where its folder would go'
      },
      {
        path: at('other', 'a.jpg'),
        reason: 'another file in this upload has the same remote path'
      }
    ])
  })
})

describe('resolvePlan', () => {
  it('applies overwrite, skip and rename, and renames around every name in or entering the folder', async () => {
    // covers: Test-756
    await localFile(at('a.jpg'), 'mine')
    await localFile(at('b.jpg'), 'mine')
    await localFile(at('c.jpg'), 'mine')
    await localFile(at('C (1).JPG'), 'mine')
    remote.addFile('/a.jpg', 1).addFile('/a (1).jpg', 2).addFile('/b.jpg', 3).addFile('/c.jpg', 4)
    const pick: Record<string, ConflictDecision> = {
      [at('a.jpg')]: 'rename',
      [at('b.jpg')]: 'overwrite',
      [at('c.jpg')]: 'rename'
    }

    const plan = await planDownload(
      deps('win32'),
      ['/a.jpg', '/a (1).jpg', '/b.jpg', '/c.jpg'],
      tmp
    )
    const resolved = resolvePlan(plan, (c) => pick[c.target])
    const skipped = resolvePlan(plan, () => 'skip')

    // 들어오는 'a (1).jpg'를 피하고, win32는 'C (1).JPG'를 대소문자 무시로 피한다
    expect(resolved.items.map((i) => [i.remotePath, i.localPath])).toEqual([
      ['/a (1).jpg', at('a (1).jpg')],
      ['/a.jpg', at('a (2).jpg')],
      ['/b.jpg', at('b.jpg')],
      ['/c.jpg', at('c (2).jpg')]
    ])
    expect(resolved.overwrites).toBe(1)
    expect(resolved.unresolved).toEqual([])
    expect(skipped.items.map((i) => i.remotePath)).toEqual(['/a (1).jpg'])
    expect(skipped.skipped).toEqual(
      ['/a.jpg', '/b.jpg', '/c.jpg'].map((p) => ({
        path: p,
        reason: 'already exists in the local folder'
      }))
    )

    // 업로드는 대소문자를 구분한다: 'A (1).JPG'가 있어도 'a (1).jpg'는 비어 있다
    remote.addDir('/up').addFile('/up/a.jpg').addFile('/up/A (1).JPG')
    const up = await planUpload(deps(), [at('a.jpg')], '/up')
    const renamed = resolvePlan(up, () => 'rename')
    expect(renamed.items).toEqual([
      { localPath: at('a.jpg'), remotePath: '/up/a (1).jpg', fileName: 'a (1).jpg', totalBytes: 4 }
    ])
    expect(resolvePlan(up, () => 'skip').skipped).toEqual([
      { path: at('a.jpg'), reason: 'already exists on the server' }
    ])

    // 로컬 경로와 원격 대상이 같은 문자열이어도(같은 경로로 배포) 업로드는 원격 이름을 바꾼다
    const same = '/var/www/index.html'
    const deploy: FolderPlan = {
      direction: 'upload',
      items: [],
      dirs: [],
      skipped: [],
      totalBytes: 0,
      overwrites: 0,
      conflicts: [
        {
          target: same,
          source: same,
          name: 'index.html',
          incoming: { size: 1, modifiedAt: '' },
          existing: { size: 1, modifiedAt: '' },
          item: { localPath: same, remotePath: same, fileName: 'index.html', totalBytes: 1 },
          renameTo: 'index (1).html',
          skipAt: 0
        }
      ]
    }
    expect(resolvePlan(deploy, () => 'rename').items).toEqual([
      {
        localPath: same,
        remotePath: '/var/www/index (1).html',
        fileName: 'index (1).html',
        totalBytes: 1
      }
    ])
    expect(resolvePlan(deploy, () => 'skip').skipped).toEqual([
      { path: same, reason: 'already exists on the server' }
    ])
  })

  it('overwrites for newer only when the incoming file is strictly later', () => {
    // covers: Test-757
    const conflict = (
      name: string,
      incomingAt: string,
      existingAt: string
    ): FolderPlan['conflicts'][number] => ({
      target: `/dest/${name}`,
      source: `/src/${name}`,
      name,
      incoming: { size: 1, modifiedAt: incomingAt },
      existing: { size: 1, modifiedAt: existingAt },
      item: {
        localPath: `/src/${name}`,
        remotePath: `/dest/${name}`,
        fileName: name,
        totalBytes: 1
      },
      renameTo: `${name} (1)`,
      skipAt: 0
    })
    const plan: FolderPlan = {
      direction: 'upload',
      items: [],
      dirs: [],
      skipped: [],
      totalBytes: 0,
      overwrites: 0,
      conflicts: [
        conflict('later', '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        conflict('same', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        conflict('older', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        conflict('no-incoming', '', '2026-01-01T00:00:00.000Z'),
        conflict('no-existing', '2026-01-02T00:00:00.000Z', '')
      ]
    }

    const resolved = resolvePlan(plan, () => 'newer')

    expect(resolved.items.map((i) => i.fileName)).toEqual(['later'])
    expect(resolved.overwrites).toBe(1)
    expect(resolved.skipped.map((s) => s.path)).toEqual([
      '/src/same',
      '/src/older',
      '/src/no-incoming',
      '/src/no-existing'
    ])
  })

  it('leaves undecided conflicts unresolved and out of the items', async () => {
    // covers: Test-758
    await localFile(at('a.jpg'), 'mine')
    await localFile(at('b.jpg'), 'mine')
    remote.addFile('/a.jpg', 1).addFile('/b.jpg', 2).addFile('/c.jpg', 3)

    const plan = await planDownload(deps(), ['/a.jpg', '/b.jpg', '/c.jpg'], tmp)
    const resolved = resolvePlan(plan, (c) => (c.name === 'a.jpg' ? 'overwrite' : undefined))

    expect(resolved.items.map((i) => i.remotePath)).toEqual(['/c.jpg', '/a.jpg'])
    expect(resolved.unresolved).toEqual([
      {
        target: at('b.jpg'),
        source: '/b.jpg',
        name: 'b.jpg',
        incoming: { size: 2, modifiedAt: '' },
        existing: { size: 4, modifiedAt: expect.any(String) }
      }
    ])
    expect(resolved.skipped).toEqual([])
  })
})

describe('planRelay', () => {
  it('expands the sending tree under the receiving folder, skipping links and empty folders', async () => {
    // covers: Test-982
    const src = new FakeRemote()
      .addDir('/photos')
      .addFile('/photos/a.jpg', 10, '2026-01-01T00:00:00.000Z')
      .addDir('/photos/sub')
      .addFile('/photos/sub/b.jpg', 20)
      .addDir('/photos/sub/deep')
      .addFile('/photos/sub/deep/c.jpg', 30)
      .addDir('/photos/empty')
      .addLink('/photos/link')
      .addFile('/top.txt', 5)
    const dst = new FakeRemote().addDir('/in')

    const plan = await planRelay(src, dst, ['/photos', '/top.txt'], '/in')

    // 항목의 localPath 자리에 보내는 쪽 경로(sourcePath)가 든다
    expect(plan.direction).toBe('relay')
    expect(plan.items).toEqual([
      {
        localPath: '/photos/a.jpg',
        remotePath: '/in/photos/a.jpg',
        fileName: 'a.jpg',
        totalBytes: 10
      },
      {
        localPath: '/photos/sub/b.jpg',
        remotePath: '/in/photos/sub/b.jpg',
        fileName: 'b.jpg',
        totalBytes: 20
      },
      {
        localPath: '/photos/sub/deep/c.jpg',
        remotePath: '/in/photos/sub/deep/c.jpg',
        fileName: 'c.jpg',
        totalBytes: 30
      },
      { localPath: '/top.txt', remotePath: '/in/top.txt', fileName: 'top.txt', totalBytes: 5 }
    ])
    expect(plan.totalBytes).toBe(65)
    expect(plan.dirs).toEqual(['/in/photos', '/in/photos/sub', '/in/photos/sub/deep'])
    expect(plan.skipped).toEqual([{ path: '/photos/link', reason: 'symbolic link' }])
    expect(plan.conflicts).toEqual([])
    expect(src.list.mock.calls.map(([dir]) => dir)).toEqual([
      '/',
      '/photos',
      '/photos/sub',
      '/photos/sub/deep',
      '/photos/empty'
    ])
    expect(dst.list.mock.calls.map(([dir]) => dir)).toEqual(['/in'])
  })

  it('checks the receiving side like an upload and keeps planUpload as it was', async () => {
    // covers: Test-983
    const src = new FakeRemote()
      .addDir('/photos')
      .addFile('/photos/a.jpg', 2, '2026-03-01T00:00:00.000Z')
      .addFile('/photos/b.jpg', 3, '2026-01-01T00:00:00.000Z')
      .addFile('/photos/docs', 4)
      .addDir('/photos/album')
      .addFile('/photos/album/x.jpg', 5)
      .addDir('/other')
      .addDir('/other/photos')
      .addFile('/other/photos/a.jpg', 6)
    const dst = new FakeRemote()
      .addDir('/in')
      .addDir('/in/photos')
      .addFile('/in/photos/a.jpg', 7, '2026-02-01T00:00:00.000Z')
      .addFile('/in/photos/A (1).JPG', 8)
      .addFile('/in/photos/b.jpg', 9, '2026-02-01T00:00:00.000Z')
      .addDir('/in/photos/docs')
      .addFile('/in/photos/album')

    const plan = await planRelay(src, dst, ['/photos', '/other/photos'], '/in')

    expect(plan.items).toEqual([])
    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        target: '/in/photos/a.jpg',
        source: '/photos/a.jpg',
        name: 'a.jpg',
        incoming: { size: 2, modifiedAt: '2026-03-01T00:00:00.000Z' },
        existing: { size: 7, modifiedAt: '2026-02-01T00:00:00.000Z' },
        // 서버 이름은 대소문자를 구분한다: 'A (1).JPG'가 있어도 'a (1).jpg'는 비어 있다
        renameTo: 'a (1).jpg'
      }),
      expect.objectContaining({
        target: '/in/photos/b.jpg',
        source: '/photos/b.jpg',
        incoming: { size: 3, modifiedAt: '2026-01-01T00:00:00.000Z' },
        existing: { size: 9, modifiedAt: '2026-02-01T00:00:00.000Z' },
        renameTo: 'b (1).jpg'
      })
    ])
    expect(plan.skipped).toEqual([
      { path: '/photos/docs', reason: 'a folder with that name exists on the server' },
      {
        path: '/photos/album/x.jpg',
        reason: 'a file on the server is where its folder would go'
      },
      {
        path: '/other/photos/a.jpg',
        reason: 'another file in this upload has the same remote path'
      }
    ])

    // 네 결정이 그대로 적용된다(대상은 받는 쪽 원격 경로)
    const decide = (d: ConflictDecision): ReturnType<typeof resolvePlan> =>
      resolvePlan(plan, () => d)
    expect(decide('overwrite')).toMatchObject({
      items: [
        { localPath: '/photos/a.jpg', remotePath: '/in/photos/a.jpg' },
        { localPath: '/photos/b.jpg', remotePath: '/in/photos/b.jpg' }
      ],
      overwrites: 2
    })
    expect(decide('rename').items.map((i) => [i.localPath, i.remotePath, i.fileName])).toEqual([
      ['/photos/a.jpg', '/in/photos/a (1).jpg', 'a (1).jpg'],
      ['/photos/b.jpg', '/in/photos/b (1).jpg', 'b (1).jpg']
    ])
    expect(decide('skip').skipped.slice(0, 2)).toEqual([
      { path: '/photos/a.jpg', reason: 'already exists on the server' },
      { path: '/photos/b.jpg', reason: 'already exists on the server' }
    ])
    const newer = decide('newer')
    expect(newer.items.map((i) => i.localPath)).toEqual(['/photos/a.jpg'])
    expect(newer.skipped[0]).toEqual({
      path: '/photos/b.jpg',
      reason: 'already exists on the server'
    })

    // planUpload의 결과는 리팩터링 전과 같다(전체 결과를 고정한다)
    await localFile(at('src', 'a.jpg'), 'aa', '2026-03-01T00:00:00.000Z')
    await localFile(at('src', 'new', 'n.jpg'), 'nnn', '2026-03-02T00:00:00.000Z')
    await localFile(at('src', 'docs'), 'd')
    await localFile(at('src', 'album', 'x.jpg'), 'x')
    await localFile(at('other', 'a.jpg'), 'again')
    remote
      .addDir('/dest')
      .addFile('/dest/a.jpg', 7, '2026-01-01T00:00:00.000Z')
      .addFile('/dest/A (1).JPG', 1)
      .addDir('/dest/docs')
      .addFile('/dest/album')
    const upload = await planUpload(
      deps(),
      [
        at('src', 'a.jpg'),
        at('src', 'new'),
        at('src', 'docs'),
        at('src', 'album'),
        at('other', 'a.jpg')
      ],
      '/dest'
    )
    expect(upload).toEqual({
      direction: 'upload',
      items: [
        {
          localPath: at('src', 'new', 'n.jpg'),
          remotePath: '/dest/new/n.jpg',
          fileName: 'n.jpg',
          totalBytes: 3
        }
      ],
      dirs: ['/dest/new'],
      skipped: [
        { path: at('src', 'docs'), reason: 'a folder with that name exists on the server' },
        {
          path: at('src', 'album', 'x.jpg'),
          reason: 'a file on the server is where its folder would go'
        },
        {
          path: at('other', 'a.jpg'),
          reason: 'another file in this upload has the same remote path'
        }
      ],
      totalBytes: 3,
      overwrites: 0,
      conflicts: [
        {
          target: '/dest/a.jpg',
          source: at('src', 'a.jpg'),
          name: 'a.jpg',
          incoming: { size: 2, modifiedAt: '2026-03-01T00:00:00.000Z' },
          existing: { size: 7, modifiedAt: '2026-01-01T00:00:00.000Z' },
          item: {
            localPath: at('src', 'a.jpg'),
            remotePath: '/dest/a.jpg',
            fileName: 'a.jpg',
            totalBytes: 2
          },
          renameTo: 'a (1).jpg',
          skipAt: 0
        }
      ]
    })
  })
})
