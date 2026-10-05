import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createAgentServices } from './index'
import { createHarness, type Harness } from './__fixtures__/fakes'
import type { AgentServices } from '../types'

let h: Harness
let services: AgentServices

beforeEach(() => {
  h = createHarness()
  services = createAgentServices(h.deps)
})

afterEach(() => h.db.close())

/** OperationManager 작업이 끝날 때까지 기다린다 */
async function settled(id: string): Promise<string> {
  const [snapshot] = await services.jobs.wait([id], 2000)
  return snapshot.status
}

describe('remote.rename', () => {
  it('refuses to overwrite an existing target without sending RNFR', async () => {
    // covers: Test-404
    h.remote.addFile('/a.txt').addFile('/b.txt').addDir('/dir').addFile('/dir/a.txt')

    await expect(services.remote.rename('/a.txt', '/b.txt')).rejects.toMatchObject({
      code: 'TARGET_EXISTS'
    })
    await expect(services.remote.rename('/a.txt', '/dir/a.txt')).rejects.toMatchObject({
      code: 'TARGET_EXISTS'
    })
    expect(h.remote.rename).not.toHaveBeenCalled()

    // 다른 폴더로의 이동도 된다
    await services.remote.rename('/a.txt', '/dir/c.txt')
    expect(h.remote.rename).toHaveBeenCalledWith('/a.txt', '/dir/c.txt')
    expect(h.remote.nodes.has('/dir/c.txt')).toBe(true)
  })
})

describe('remote delete', () => {
  it('counts folders recursively and runs the delete as an OperationManager job', async () => {
    // covers: Test-405
    h.remote
      .addDir('/a')
      .addFile('/a/1.txt')
      .addDir('/a/b')
      .addFile('/a/b/2.txt')
      .addLink('/a/b/link')
      .addDir('/a/b/c')
      .addFile('/x.txt')
      .addFile('/keep.txt')

    const plan = await services.remote.planDelete(['/a', '/x.txt', '/a/b'])

    expect(plan).toEqual({
      targets: [
        { path: '/a', kind: 'directory', entries: 5 },
        { path: '/x.txt', kind: 'file' }
      ],
      totalFiles: 4,
      totalDirectories: 3,
      session: services.session.key()
    })

    const id = services.remote.startDelete(plan)
    const job = h.operations.getAll().find((j) => j.id === id)
    expect(job).toMatchObject({ kind: 'delete', itemCount: 2, status: 'active' })
    expect(await settled(id)).toBe('completed')
    expect([...h.remote.nodes.keys()].sort()).toEqual(['/', '/keep.txt'])
    expect(h.remote.deleteDirectory).toHaveBeenCalledWith('/a', expect.any(Function))
    expect(h.remote.deleteFile).toHaveBeenCalledWith('/x.txt')
  })
})

describe('remote.mkdir', () => {
  it('fails when the folder is not there afterwards instead of reporting success', async () => {
    // covers: Test-417
    await services.remote.mkdir('/new/sub')
    expect(h.remote.nodes.get('/new/sub')?.type).toBe('directory')

    h.remote.ignoreMkd = true
    await expect(services.remote.mkdir('/denied')).rejects.toThrow(/did not create/)

    h.remote.addFile('/file')
    await expect(services.remote.mkdir('/file')).rejects.toMatchObject({ code: 'TARGET_EXISTS' })
  })
})

describe('remote path validation', () => {
  it('rejects relative remote paths and CR, LF or NUL with INVALID_PATH', async () => {
    // covers: Test-419
    const bad = ['photos', '', '/a\r\nDELE /b', '/a\0b']
    for (const p of bad) {
      await expect(services.remote.list(p)).rejects.toMatchObject({ code: 'INVALID_PATH' })
      await expect(services.remote.mkdir(p)).rejects.toMatchObject({ code: 'INVALID_PATH' })
      await expect(services.remote.rename('/a', p)).rejects.toMatchObject({ code: 'INVALID_PATH' })
      await expect(services.remote.planDelete([p])).rejects.toMatchObject({ code: 'INVALID_PATH' })
      await expect(services.transfers.planDownload([p], '/tmp', 'skip')).rejects.toMatchObject({
        code: 'INVALID_PATH'
      })
      await expect(services.transfers.planUpload(['/tmp'], p, 'skip')).rejects.toMatchObject({
        code: 'INVALID_PATH'
      })
    }
    // 루트는 지우지 않는다
    await expect(services.remote.planDelete(['/'])).rejects.toMatchObject({ code: 'INVALID_PATH' })
    expect(h.remote.list).not.toHaveBeenCalled()
  })
})

describe('remote delete session check', () => {
  it('stops before the next target once the FTP session changed', async () => {
    // covers: Test-606
    h.remote.addFile('/a.txt').addFile('/b.txt')
    const plan = await services.remote.planDelete(['/a.txt', '/b.txt'])
    // 첫 대상을 지우는 사이 사용자가 GUI에서 다른 서버로 연결한다
    h.remote.deleteFile.mockImplementationOnce(async (p: string) => {
      h.remote.nodes.delete(p)
      await h.remote.connect({
        host: 'other.example',
        port: 21,
        user: 'me',
        password: 'pw',
        secure: false
      })
    })

    const id = services.remote.startDelete(plan)

    expect(await settled(id)).toBe('failed')
    expect(services.jobs.get([id])[0].error).toMatch(/^SESSION_CHANGED: /)
    expect(h.remote.deleteFile).toHaveBeenCalledTimes(1)
    expect(h.remote.nodes.has('/b.txt')).toBe(true)
  })
})

describe('normalized remote paths', () => {
  it("rejects empty, '.' and '..' segments and trailing slashes before touching the server", async () => {
    // covers: Test-616
    h.remote.addDir('/uploads').addDir('/tmp').addDir('/tmp/old').addDir('/www')
    const bad = ['//uploads', '/uploads/', '/./a', '/a/.', '/tmp/old/../../www', '/a//b']
    for (const p of bad) {
      for (const attempt of [
        services.remote.list(p),
        services.remote.mkdir(p),
        services.remote.rename(p, '/b'),
        services.remote.rename('/a', p),
        services.remote.planDelete([p]),
        services.transfers.planDownload([p], '/tmp', 'skip'),
        // 예전에는 '//uploads'가 계획 안에서 끝없이 돌다 스택이 넘쳤다
        services.transfers.planUpload(['/tmp'], p, 'skip'),
        services.session.connect(1, p)
      ]) {
        await expect(attempt, p).rejects.toMatchObject({
          code: 'INVALID_PATH',
          message: expect.stringContaining('use a normalized absolute path')
        })
      }
    }
    expect(h.remote.list).not.toHaveBeenCalled()
    await expect(services.remote.list('/uploads')).resolves.toMatchObject({ path: '/uploads' })
  })
})

describe('remote delete plan per folder', () => {
  it('counts the entries of each folder target in the same walk that counts the plan', async () => {
    // covers: Test-682
    h.remote
      .addDir('/a')
      .addFile('/a/1.txt')
      .addDir('/a/b')
      .addFile('/a/b/2.txt')
      .addDir('/a/b/c')
      .addDir('/empty')
      .addFile('/x.txt')

    const plan = await services.remote.planDelete(['/a', '/empty', '/x.txt'])

    expect(plan.targets).toEqual([
      { path: '/a', kind: 'directory', entries: 4 },
      { path: '/empty', kind: 'directory', entries: 0 },
      { path: '/x.txt', kind: 'file' }
    ])
    expect(plan).toMatchObject({ totalFiles: 3, totalDirectories: 4 })
    // 부모 '/' 한 번과 폴더마다 한 번: /a, /a/b, /a/b/c, /empty. 같은 폴더를 다시 읽지 않는다.
    expect(h.remote.list.mock.calls.map(([dir]) => dir)).toEqual([
      '/',
      '/a',
      '/a/b',
      '/a/b/c',
      '/empty'
    ])
  })
})

describe('remote.readFile', () => {
  const KiB = 1024

  it('reads at most the limit over a secondary connection, or a small file over the main one', async () => {
    // covers: Test-688
    h.remote.addText('/big.log', Buffer.alloc(200 * KiB, 'x')).addText('/small.txt', 'hello')

    const big = await services.remote.readFile('/big.log', 64 * KiB)
    expect(big.data).toEqual(Buffer.alloc(64 * KiB, 'x'))
    expect(big).toMatchObject({ size: 200 * KiB, truncated: true })
    const [client] = h.remote.secondaryClients
    expect(client.close).toHaveBeenCalled()
    // 한도를 넘긴 순간 멈춘다: 200 KiB를 다 받지 않는다.
    expect(client.bytesSent).toBeLessThan(200 * KiB)

    const small = await services.remote.readFile('/small.txt', 64 * KiB)
    expect(small).toEqual({ size: 5, data: Buffer.from('hello'), truncated: false })
    expect(h.remote.createSecondaryClient).toHaveBeenCalledTimes(2)
    expect(h.remote.secondaryClients[1].close).toHaveBeenCalled()
    expect(h.remote.mainClient.downloadTo).not.toHaveBeenCalled()

    // 서버가 보조 연결을 거부하면 메인 연결로 읽되, 끝까지 받아야 하는 큰 파일은 읽지 않는다.
    h.remote.refuseSecondary = true
    expect(await services.remote.readFile('/small.txt', 64 * KiB)).toEqual(small)
    expect(h.remote.mainClient.downloadTo).toHaveBeenCalledTimes(1)
    await expect(services.remote.readFile('/big.log', 64 * KiB)).rejects.toMatchObject({
      code: 'BUSY',
      message: expect.stringContaining('/big.log')
    })
    expect(h.remote.mainClient.downloadTo).toHaveBeenCalledTimes(1)
  })
})
