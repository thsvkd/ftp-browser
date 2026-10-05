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

    const plan = await services.remote.planDelete(['/a/', '/x.txt', '/a/b'])

    expect(plan).toEqual({
      targets: [
        { path: '/a', kind: 'directory' },
        { path: '/x.txt', kind: 'file' }
      ],
      totalFiles: 4,
      totalDirectories: 3
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
