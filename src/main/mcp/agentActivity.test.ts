import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { Client } from '@modelcontextprotocol/client'
import type { AgentActivityEvent } from '@shared/types/mcp'
import type { FtpListResult } from '@shared/types/ftp'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { clientName, createAgentActivity, summarizeTarget } from './agentActivity'
import { createMcpToolServer } from './mcpTools'
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

/** 중지된 호출이 백그라운드에서 마저 도는 동안 기다린다(그 결과는 에이전트에게 가지 않는다). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

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

    expect(h.hub.cancelMany.mock.calls).toEqual([[[running.jobId]]])
    expect(h.queue.jobs.find((job) => job.id === running.jobId)?.status).toBe('cancelled')
    expect(h.queue.jobs.find((job) => job.id === gui.id)?.status).toBe('active')
    expect(cancel).toHaveBeenCalledWith(deleting.operationId)
    expect(last()).toMatchObject({ active: false, stopped: true })
  })

  it('a call stopped while it plans a download lists no further and queues nothing', async () => {
    // covers: Test-1354
    h.remote.addDir('/folder').addDir('/folder/sub').addFile('/folder/sub/a.txt', 3)
    const held = holdList()
    const pending = call(client, 'download', { remotePaths: ['/folder'], localDir: tmp })
    await vi.waitFor(() => expect(h.remote.list).toHaveBeenCalled())

    h.deps.activity!.stop()
    expect(textOf(await pending)).toMatch(/^STOPPED_BY_USER/)
    held.release()
    await settle()

    expect(h.remote.list).toHaveBeenCalledTimes(1)
    expect(h.queue.enqueueBatch).not.toHaveBeenCalled()
    await expect(fs.readdir(tmp)).resolves.toEqual([])
    expect(last()).toMatchObject({ active: false, stopped: true })
  })

  it('cancels at once a job a stopped call still hands over', () => {
    // covers: Test-1354
    const queued = h.queue.add({ status: 'pending' })
    const activity = h.deps.activity!
    const running = activity.begin('download', {})
    activity.stop()

    running.track([queued.id])

    expect(h.hub.cancelMany).toHaveBeenLastCalledWith([queued.id])
    expect(queued.status).toBe('cancelled')
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

  it.each([
    ['a file', '/keep.txt'],
    ['a folder', '/keep']
  ])('a delete of %s stopped while it checks the paths deletes nothing', async (_kind, target) => {
    // covers: Test-1358
    h.remote.addFile('/keep.txt', 1).addDir('/keep').addFile('/keep/a', 1)
    const held = holdList()
    const pending = call(client, 'delete', { paths: [target] })
    await vi.waitFor(() => expect(h.remote.list).toHaveBeenCalled())

    h.deps.activity!.stop()
    expect(textOf(await pending)).toMatch(/^STOPPED_BY_USER/)
    held.release()
    await settle()

    expect(h.remote.deleteFile).not.toHaveBeenCalled()
    expect(h.remote.deleteDirectory).not.toHaveBeenCalled()
    expect(h.operations.getAll()).toEqual([])
  })

  it('a rename stopped while it checks the target sends no rename', async () => {
    // covers: Test-1359
    h.remote.addFile('/a.txt', 1)
    const held = holdList()
    const pending = call(client, 'rename', { from: '/a.txt', to: '/b.txt' })
    await vi.waitFor(() => expect(h.remote.list).toHaveBeenCalled())

    h.deps.activity!.stop()
    expect(textOf(await pending)).toMatch(/^STOPPED_BY_USER/)
    held.release()
    await settle()

    expect(h.remote.rename).not.toHaveBeenCalled()
  })

  it('keeps showing a transfer Stop could not cancel until it ends, then hides at once', async () => {
    // covers: Test-1360
    h.remote.addFile('/a.txt', 3)
    const { jobId } = dataOf<{ jobId: string }>(
      await call(client, 'download', { remotePaths: ['/a.txt'], localDir: tmp })
    )
    h.queue.jobs.find((job) => job.id === jobId)!.status = 'active'
    h.queue.mainClient.add(jobId)

    h.deps.activity!.stop()
    expect(last()).toMatchObject({ active: true, tool: 'download' })
    expect(last()?.stopped).toBeUndefined()

    h.queue.finish(jobId, 'completed')
    expect(last()).toMatchObject({ active: false, stopped: true })
    expect(h.deps.activity!.current()).toEqual(last())
  })

  it('names the event after the client in the request envelope', async () => {
    // covers: Test-1362
    // ftpb처럼 initialize 없이 2026-07-28 `_meta` envelope 하나로 부른다
    const handler = createMcpHandler(() => createMcpToolServer(h.deps))
    const version = '2026-07-28'
    const res = await handler.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': version,
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'get_status'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'get_status',
            arguments: {},
            _meta: {
              'io.modelcontextprotocol/protocolVersion': version,
              'io.modelcontextprotocol/clientInfo': { name: 'ftpb', version: '1' },
              'io.modelcontextprotocol/clientCapabilities': {}
            }
          }
        })
      })
    )
    expect(res.status).toBe(200)
    await res.text()
    expect(last()).toMatchObject({ active: false, tool: 'get_status', client: 'ftpb' })
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

  it('treats a name of only spaces and control characters as no name', () => {
    // covers: Test-1361
    expect(clientName('\u202E\u200B')).toBeUndefined()
    expect(clientName('  ', 'codex_cli_rs/0.164.0')).toBe('Codex')
    expect(clientName(' ftpb ')).toBe('ftpb')
  })
})
