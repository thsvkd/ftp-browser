import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// LocalFileSystem은 getHomePath() 때문에 electron app을 임포트한다
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => os.tmpdir()) } }))

import { LocalFileSystem } from '../../local/LocalFileSystem'
import { createAgentServices } from './index'
import { createHarness, type Harness } from './__fixtures__/fakes'
import type { AgentServices } from '../types'

let h: Harness
let services: AgentServices
let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-local-'))
  h = createHarness({ localFs: new LocalFileSystem() })
  services = createAgentServices(h.deps)
})

afterEach(async () => {
  h.db.close()
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('local changes', () => {
  it('announces mkdir, rename and delete through local:changed', async () => {
    // covers: Test-413
    const dir = path.join(tmp, 'new')
    await services.local.mkdir(dir)
    expect(h.events.localChanged).toHaveBeenLastCalledWith({ paths: [dir] })

    const renamed = path.join(tmp, 'renamed')
    await services.local.rename(dir, renamed)
    expect(h.events.localChanged).toHaveBeenLastCalledWith({ paths: [dir, renamed] })

    await fs.writeFile(path.join(renamed, 'a.txt'), 'a')
    await fs.writeFile(path.join(tmp, 'b.txt'), 'b')
    const plan = await services.local.planDelete([renamed, path.join(tmp, 'b.txt')])
    expect(plan).toEqual({
      targets: [
        { path: renamed, kind: 'directory' },
        { path: path.join(tmp, 'b.txt'), kind: 'file' }
      ],
      totalFiles: 2,
      totalDirectories: 1
    })
    h.events.localChanged.mockClear()
    const id = services.local.startDelete(plan)
    const [snapshot] = await services.jobs.wait([id], 2000)

    expect(snapshot).toMatchObject({ kind: 'operation', status: 'completed', done: true })
    expect(await fs.readdir(tmp)).toEqual([])
    expect(h.events.localChanged).toHaveBeenCalledWith({
      paths: [renamed, path.join(tmp, 'b.txt')]
    })
  })

  it('keeps rename_local in its folder and never overwrites', async () => {
    // covers: Test-420
    await fs.writeFile(path.join(tmp, 'a.txt'), 'a')
    await fs.writeFile(path.join(tmp, 'b.txt'), 'b')
    await fs.mkdir(path.join(tmp, 'sub'))

    await expect(
      services.local.rename(path.join(tmp, 'a.txt'), path.join(tmp, 'b.txt'))
    ).rejects.toMatchObject({ code: 'TARGET_EXISTS' })
    await expect(
      services.local.rename(path.join(tmp, 'a.txt'), path.join(tmp, 'sub', 'a.txt'))
    ).rejects.toMatchObject({ code: 'INVALID_PATH' })
    expect(await fs.readFile(path.join(tmp, 'b.txt'), 'utf8')).toBe('b')
    expect(h.events.localChanged).not.toHaveBeenCalled()
  })
})

describe('local path validation', () => {
  it('rejects relative paths and control characters with INVALID_PATH', async () => {
    // covers: Test-414
    const bad = ['relative/dir', '', path.join(tmp, 'a\nb'), path.join(tmp, 'a\0b')]
    for (const p of bad) {
      await expect(services.local.list(p)).rejects.toMatchObject({ code: 'INVALID_PATH' })
      await expect(services.local.mkdir(p)).rejects.toMatchObject({ code: 'INVALID_PATH' })
      await expect(services.local.rename(path.join(tmp, 'x'), p)).rejects.toMatchObject({
        code: 'INVALID_PATH'
      })
      await expect(services.local.planDelete([p])).rejects.toMatchObject({ code: 'INVALID_PATH' })
      await expect(services.transfers.planDownload(['/a'], p, 'skip')).rejects.toMatchObject({
        code: 'INVALID_PATH'
      })
      await expect(services.transfers.planUpload([p], '/', 'skip')).rejects.toMatchObject({
        code: 'INVALID_PATH'
      })
    }
    await expect(services.local.planDelete([path.parse(tmp).root])).rejects.toMatchObject({
      code: 'INVALID_PATH'
    })
    expect(await fs.readdir(tmp)).toEqual([])
    expect(h.remote.list).not.toHaveBeenCalled()
  })
})
