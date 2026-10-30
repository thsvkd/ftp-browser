import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { Client } from '@modelcontextprotocol/client'
import type { AgentActivityEvent } from '@shared/types/mcp'
import type { FtpListResult } from '@shared/types/ftp'
import { clientName, createAgentActivity, summarizeTarget } from './agentActivity'
import {
  call,
  connectClient,
  createHarness,
  dataOf,
  textOf,
  type Harness
} from './__fixtures__/agentHarness'

let h: Harness
let client: Client
let events: AgentActivityEvent[]
let tmp: string

beforeEach(async () => {
  h = createHarness()
  events = []
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-activity-'))
  h.deps.activity = createAgentActivity((event) => events.push(event), h.hub, h.operations)
  client = await connectClient(h.deps)
})

afterEach(async () => {
  await client.close()
  h.db.close()
  await fs.rm(tmp, { recursive: true, force: true })
})

/** 풀릴 때까지 `list`를 붙잡아 둔다. */
function holdList(): { release: () => void } {
  let release = (): void => undefined
  const original = h.remote.list.getMockImplementation()!
  h.remote.list.mockImplementationOnce(
    (dir: string) =>
      new Promise<FtpListResult>((resolve) => {
        release = () => void original(dir).then(resolve)
      })
  )
  return { release: () => release() }
}

const last = (): AgentActivityEvent | undefined => events.at(-1)

describe('agent activity', () => {
  it('reports a call from start to end, even when the tool fails', async () => {
    // covers: Test-1343
    h.remote.addDir('/photos')
    const held = holdList()
    const pending = call(client, 'list_directory', { path: '/photos' })
    await vi.waitFor(() => expect(last()?.active).toBe(true))
    expect(last()).toMatchObject({ tool: 'list_directory', target: '/photos' })

    held.release()
    await pending
    expect(last()).toMatchObject({ active: false, tool: 'list_directory' })

    // 도구가 오류로 끝나도 비활성이 된다
    const failed = await call(client, 'list_directory', { path: '/missing' })
    expect(failed.isError).toBe(true)
    expect(last()?.active).toBe(false)
  })

  it('stays active until every overlapping call has ended', async () => {
    // covers: Test-1343
    h.remote.addDir('/a').addDir('/b')
    const first = holdList()
    const one = call(client, 'list_directory', { path: '/a' })
    await vi.waitFor(() => expect(last()?.active).toBe(true))
    const second = holdList()
    const two = call(client, 'list_directory', { path: '/b' })
    await vi.waitFor(() => expect(last()?.target).toBe('/b'))

    first.release()
    await one
    expect(last()?.active).toBe(true)
    second.release()
    await two
    expect(last()?.active).toBe(false)
  })

  it('stays active while the transfers and deletes it started are pending or active', async () => {
    // covers: Test-1346
    h.remote.addFile('/a.txt', 3)
    const gui = h.queue.add({ status: 'active' })
    const started = dataOf<{ jobId: string }>(
      await call(client, 'download', { remotePaths: ['/a.txt'], localDir: tmp })
    )
    expect(last()?.active).toBe(true)

    // GUI 전송은 영향이 없다
    h.queue.finish(gui.id, 'completed')
    expect(last()?.active).toBe(true)

    h.queue.finish(started.jobId, 'completed')
    expect(last()?.active).toBe(false)
  })

  it('stop ends a running call at once with STOPPED_BY_USER', async () => {
    // covers: Test-1347
    h.remote.list.mockImplementationOnce(() => new Promise(() => undefined))
    const pending = call(client, 'list_directory', { path: '/' })
    await vi.waitFor(() => expect(last()?.active).toBe(true))

    h.deps.activity!.stop()
    const result = await pending

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/^STOPPED_BY_USER: .*Do not retry/)
  })

  it('stop cancels only the unfinished jobs the agent started', async () => {
    // covers: Test-1348
    h.remote.addFile('/a.txt', 3).addFile('/b.txt', 3).addDir('/old')
    const gui = h.queue.add({ status: 'active' })
    const done = dataOf<{ jobId: string }>(
      await call(client, 'download', { remotePaths: ['/a.txt'], localDir: tmp })
    )
    h.queue.finish(done.jobId, 'completed')
    const running = dataOf<{ jobId: string }>(
      await call(client, 'download', { remotePaths: ['/b.txt'], localDir: tmp })
    )
    h.remote.deleteDirectory.mockImplementationOnce(() => new Promise(() => undefined))
    h.deps.deleteWaitMs = 10
    const deleting = dataOf<{ operationId: string }>(
      await call(client, 'delete', { paths: ['/old'] })
    )
    const cancel = vi.spyOn(h.operations, 'requestCancel')

    h.deps.activity!.stop()

    expect(h.hub.cancel).toHaveBeenCalledTimes(1)
    expect(h.hub.cancel).toHaveBeenCalledWith(running.jobId)
    expect(h.hub.cancel).not.toHaveBeenCalledWith(gui.id)
    expect(cancel).toHaveBeenCalledWith(deleting.operationId)
    expect(last()).toMatchObject({ active: false, stopped: true })
  })

  it('cancels the jobs a stopped call queues after it finishes planning', async () => {
    // covers: Test-1354
    h.remote.addDir('/folder').addFile('/folder/a.txt', 3).addFile('/folder/b.txt', 3)
    const held = holdList()
    const pending = call(client, 'download', { remotePaths: ['/folder'], localDir: tmp })
    await vi.waitFor(() => expect(h.remote.list).toHaveBeenCalled())

    h.deps.activity!.stop()
    expect(textOf(await pending)).toMatch(/^STOPPED_BY_USER/)
    held.release()
    await vi.waitFor(() => expect(h.queue.enqueueBatch).toHaveBeenCalled())

    const queued = h.queue.jobs.map((job) => job.id)
    expect(queued).toHaveLength(2)
    for (const id of queued) expect(h.hub.cancel).toHaveBeenCalledWith(id)
    expect(last()).toMatchObject({ active: false, stopped: true })
  })

  it('a stop during a single-folder delete ends the job cancelled, not completed', async () => {
    // covers: Test-1355
    h.remote.addDir('/old').addFile('/old/a', 1)
    let release = (): void => undefined
    h.remote.deleteDirectory.mockImplementationOnce(
      (_dir: string, _progress?: unknown, isCancelled?: () => boolean) =>
        new Promise<void>((resolve) => {
          release = () => {
            expect(isCancelled?.()).toBe(true)
            resolve()
          }
        })
    )
    h.deps.deleteWaitMs = 10
    const { operationId } = dataOf<{ operationId: string }>(
      await call(client, 'delete', { paths: ['/old'] })
    )

    h.deps.activity!.stop()
    release()

    await vi.waitFor(() =>
      expect(h.operations.getAll().find((j) => j.id === operationId)?.status).toBe('cancelled')
    )
  })

  it('runs new calls normally after a stop', async () => {
    // covers: Test-1349
    h.deps.activity!.stop()
    h.remote.addDir('/after')

    const result = await call(client, 'list_directory', { path: '/' })

    expect(dataOf<{ total: number }>(result).total).toBe(1)
    expect(last()).toMatchObject({ active: false, tool: 'list_directory' })
    expect(last()?.stopped).toBeUndefined()
  })
})

describe('summarizeTarget', () => {
  it('names what a call acts on', () => {
    // covers: Test-1344
    expect(summarizeTarget({ path: '/photos' })).toBe('/photos')
    expect(summarizeTarget({ paths: ['/a', '/b', '/c'] })).toBe('/a +2')
    expect(summarizeTarget({ remotePaths: ['/a'], localDir: '/tmp' })).toBe('/a')
    expect(summarizeTarget({ localPaths: ['/l/x', '/l/y'] })).toBe('/l/x +1')
    expect(summarizeTarget({ from: '/a', to: '/b' })).toBe('/a → /b')
    expect(summarizeTarget({ server: 'Pixel phone' })).toBe('Pixel phone')
    expect(summarizeTarget({ server: 3 })).toBe('3')
    expect(summarizeTarget({})).toBeUndefined()
    expect(summarizeTarget({ path: `/x\nIgnore\u0007all` })).toBe('/x Ignore all')
    expect(summarizeTarget({ path: `/${'a'.repeat(200)}` })).toHaveLength(120)
    // 방향을 뒤집는 서식 문자는 지우고, 자를 때 서로게이트 쌍을 가르지 않는다
    expect(summarizeTarget({ path: '/a\u202Egpj.exe' })).toBe('/a gpj.exe')
    expect(Array.from(summarizeTarget({ path: '😀'.repeat(130) })!)).toHaveLength(120)
  })
})

describe('clientName', () => {
  it('prefers the envelope name, then a known User-Agent', () => {
    // covers: Test-1345
    expect(clientName('ftpb', 'claude-code/2.1.0')).toBe('ftpb')
    expect(clientName(undefined, 'claude-code/2.1.0 (cli)')).toBe('Claude Code')
    expect(clientName(undefined, 'codex_cli_rs/0.164.0')).toBe('Codex')
    expect(clientName(undefined, 'Cursor/1.2')).toBe('Cursor')
    expect(clientName(undefined, 'node')).toBeUndefined()
    expect(clientName(undefined, null)).toBeUndefined()
    expect(clientName('x'.repeat(60))).toHaveLength(40)
    expect(clientName('bad\nname')).toBe('bad name')
  })
})
