import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// LocalFileSystem은 getHomePath() 때문에 electron app을 임포트한다
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => os.tmpdir()) } }))

import { DEFAULT_AGENT_POLICY, type AgentPolicy } from '@shared/types/agent'
import { LocalFileSystem } from '../local/LocalFileSystem'
import { createAgentServices } from '../agent/services'
import { createHarness, type Harness } from '../agent/services/__fixtures__/fakes'
import type { DownloadPlan, JobSnapshot } from '../agent/types'
import { JobHandles } from './jobHandles'
import type { McpToolDeps } from './mcpTools'
import type { ConfirmInput, ConfirmOutcome } from './confirmationBroker'
import { ActionLock } from './toolRegistry'
import {
  ALLOW_ALL,
  connectClient,
  defaultWorld,
  fakeServices,
  makeDeps,
  textOf
} from './__fixtures__/agentToolHarness'

const WAITING_BUSY =
  /^BUSY: FTP Browser is waiting for the user to answer a confirmation; retry after it is answered\. /

let h: Harness | undefined
const tmpDirs: string[] = []

afterEach(() => {
  h?.db.close()
  h = undefined
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-safety-'))
  tmpDirs.push(dir)
  return dir
}

function addServer(harness: Harness, name: string, host: string): number {
  return Number(
    harness.db
      .prepare(
        'INSERT INTO servers (name, host, port, username, password_enc, secure) VALUES (?, ?, 21, ?, ?, 0)'
      )
      .run(name, host, 'me', 'pw').lastInsertRowid
  )
}

/** 실제 서비스(가짜 FTP·큐) 위의 도구 서버. 확인 요청은 테스트가 answer()로 답할 때까지 열려 있다. */
function wire(
  options: { localFs?: LocalFileSystem; localRoot?: string; policy?: Partial<AgentPolicy> } = {}
): {
  harness: Harness
  deps: McpToolDeps & { notify: { activity: ReturnType<typeof vi.fn> } }
  asked: ConfirmInput[]
  answer: (outcome: ConfirmOutcome) => void
} {
  const harness = createHarness(options.localFs ? { localFs: options.localFs } : {})
  h = harness
  const asked: ConfirmInput[] = []
  const answers: Array<(outcome: ConfirmOutcome) => void> = []
  const deps = {
    version: 'test',
    services: createAgentServices(harness.deps),
    operations: harness.operations,
    policy: { get: () => ({ ...DEFAULT_AGENT_POLICY, ...options.policy }) },
    confirm: vi.fn(
      (request: ConfirmInput) =>
        new Promise<ConfirmOutcome>((resolve) => {
          asked.push(request)
          answers.push(resolve)
        })
    ),
    notify: { activity: vi.fn(), openServerEditor: vi.fn(() => true) },
    previews: vi.fn(),
    jobHandles: new JobHandles(),
    actionLock: new ActionLock(),
    localRoot: options.localRoot ?? '/home/u',
    timing: { deleteWaitMs: 200, progressIntervalMs: 60_000 }
  }
  return { harness, deps, asked, answer: (outcome) => answers.shift()!(outcome) }
}

const GUI_CONNECT = { host: 'other.example', port: 21, user: 'me', password: 'pw', secure: false }

describe('action lock (spec §9 R1)', () => {
  it('refuses connect with BUSY while a delete waits for approval, then deletes on the planned server', async () => {
    // covers: Test-600
    const { harness, deps, asked, answer } = wire()
    addServer(harness, 'staging', 'staging.example')
    const prod = addServer(harness, 'prod', 'prod.example')
    harness.remote.host = 'staging.example'
    harness.remote.addDir('/www').addFile('/www/index.html')
    const ranOn: string[] = []
    harness.remote.deleteDirectory.mockImplementation(async (dir: string) => {
      ranOn.push(`${harness.remote.host}:${dir}`)
    })
    const client = await connectClient(deps)

    const del = client.callTool({ name: 'delete', arguments: { paths: ['/www'] } })
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    expect(asked[0].host).toBe('staging.example')
    const switched = await client.callTool({ name: 'connect', arguments: { server: prod } })

    expect(switched.isError).toBe(true)
    expect(textOf(switched)).toMatch(WAITING_BUSY)
    expect(harness.remote.connect).not.toHaveBeenCalled()
    answer('approved')
    expect((await del).isError).toBeFalsy()
    await vi.waitFor(() => expect(ranOn).toEqual(['staging.example:/www']))
  })

  it('refuses remote renames while a delete waits, so a swapped-in folder is never deleted', async () => {
    // covers: Test-601
    const { harness, deps, asked, answer } = wire()
    harness.remote.addDir('/tmp').addDir('/tmp/empty').addDir('/important')
    for (let i = 0; i < 5; i++) harness.remote.addFile(`/important/f${i}`)
    const client = await connectClient(deps)

    const del = client.callTool({ name: 'delete', arguments: { paths: ['/tmp/empty'] } })
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    const first = await client.callTool({
      name: 'rename',
      arguments: { from: '/tmp/empty', to: '/tmp/e2' }
    })
    const second = await client.callTool({
      name: 'rename',
      arguments: { from: '/important', to: '/tmp/empty' }
    })
    answer('approved')
    const result = await del

    expect(asked[0].totalItems).toBe(1)
    for (const renamed of [first, second]) expect(textOf(renamed)).toMatch(WAITING_BUSY)
    expect(harness.remote.rename).not.toHaveBeenCalled()
    expect(result.isError).toBeFalsy()
    await vi.waitFor(() => expect(harness.remote.nodes.has('/tmp/empty')).toBe(false))
    for (let i = 0; i < 5; i++) expect(harness.remote.nodes.has(`/important/f${i}`)).toBe(true)
  })

  it('refuses rename_local while delete_local waits, so a swapped-in folder is never deleted', async () => {
    // covers: Test-602
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, 'empty'))
    fs.mkdirSync(path.join(dir, 'thesis'))
    fs.writeFileSync(path.join(dir, 'thesis', 'ch1.tex'), 'x')
    const { deps, asked, answer } = wire({ localFs: new LocalFileSystem(), localRoot: dir })
    const client = await connectClient(deps)

    const del = client.callTool({
      name: 'delete_local',
      arguments: { paths: [path.join(dir, 'empty')] }
    })
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    const renames = [
      await client.callTool({
        name: 'rename_local',
        arguments: { from: path.join(dir, 'empty'), to: path.join(dir, 'e2') }
      }),
      await client.callTool({
        name: 'rename_local',
        arguments: { from: path.join(dir, 'thesis'), to: path.join(dir, 'empty') }
      })
    ]
    answer('approved')
    await del

    for (const renamed of renames) expect(textOf(renamed)).toMatch(WAITING_BUSY)
    await vi.waitFor(() => expect(fs.readdirSync(dir)).toEqual(['thesis']))
    expect(fs.readFileSync(path.join(dir, 'thesis', 'ch1.tex'), 'utf8')).toBe('x')
  })

  it('lets read tools and dryRun through, says which call holds the lock and frees it after every outcome', async () => {
    // covers: Test-603
    const world = defaultWorld()
    const services = fakeServices(world)
    const deps = makeDeps(services)
    let answer: (outcome: ConfirmOutcome) => void = () => undefined
    deps.confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const client = await connectClient(deps)

    const del = client.callTool({ name: 'delete', arguments: { paths: ['/a.jpg'] } })
    await vi.waitFor(() => expect(deps.confirm).toHaveBeenCalledTimes(1))
    const reads = [
      await client.callTool({ name: 'get_status', arguments: {} }),
      await client.callTool({ name: 'list_directory', arguments: { path: '/' } }),
      await client.callTool({ name: 'list_jobs', arguments: {} }),
      await client.callTool({ name: 'wait_for_jobs', arguments: { ids: ['x'], timeoutSec: 1 } }),
      await client.callTool({ name: 'create_directory', arguments: { path: '/n', dryRun: true } })
    ]
    const blocked = await client.callTool({ name: 'create_directory', arguments: { path: '/n' } })
    answer('denied')
    const declined = await del

    for (const read of reads) expect(read.isError, textOf(read)).toBeFalsy()
    expect(textOf(blocked)).toMatch(WAITING_BUSY)
    expect(textOf(blocked)).toContain('wait_for_jobs')
    expect(textOf(declined)).toMatch(/^DENIED_BY_USER: /)
    expect(
      (await client.callTool({ name: 'create_directory', arguments: { path: '/n' } })).isError
    ).toBeFalsy()

    // 계획이 실패해도 잠금이 풀린다
    services.remote.planDelete = vi.fn(async () => {
      throw Object.assign(new Error('550 Gone'), { code: 550 })
    })
    expect(
      (await client.callTool({ name: 'delete', arguments: { paths: ['/a.jpg'] } })).isError
    ).toBe(true)
    expect(
      (await client.callTool({ name: 'create_directory', arguments: { path: '/m' } })).isError
    ).toBeFalsy()

    // 확인 없이 계획 중인 호출도 잠금을 잡는다
    let finishPlan: (plan: DownloadPlan) => void = () => undefined
    services.transfers.planDownload = vi.fn(
      () =>
        new Promise<DownloadPlan>((resolve) => {
          finishPlan = resolve
        })
    )
    const download = client.callTool({
      name: 'download',
      arguments: { remotePaths: ['/a.jpg'], localDir: '/home/u' }
    })
    await vi.waitFor(() => expect(services.transfers.planDownload).toHaveBeenCalled())
    const starting = await client.callTool({ name: 'rename', arguments: { from: '/a', to: '/b' } })
    finishPlan({
      items: [{ remotePath: '/a.jpg', localPath: '/home/u/a.jpg', size: 1 }],
      createDirs: [],
      skipped: [],
      totalBytes: 1
    })

    expect(textOf(starting)).toMatch(
      /^BUSY: FTP Browser is still starting another action \(download\); retry when that call has returned\. /
    )
    expect((await download).isError).toBeFalsy()
    expect(services.remote.rename).not.toHaveBeenCalled()
  })

  it('releases the lock before delete waits for its job', async () => {
    // covers: Test-604
    const world = defaultWorld()
    const services = fakeServices(world)
    const deps = makeDeps(services)
    deps.currentPolicy = ALLOW_ALL
    const done: JobSnapshot = {
      id: 'op-remote',
      kind: 'operation',
      status: 'completed',
      done: true,
      name: 'photos'
    }
    let finishWait: (jobs: JobSnapshot[]) => void = () => undefined
    services.jobs.wait = vi.fn(
      () =>
        new Promise<JobSnapshot[]>((resolve) => {
          finishWait = resolve
        })
    )
    const client = await connectClient(deps)

    const del = client.callTool({ name: 'delete', arguments: { paths: ['/photos'] } })
    await vi.waitFor(() => expect(services.jobs.wait).toHaveBeenCalled())
    const meanwhile = await client.callTool({ name: 'create_directory', arguments: { path: '/n' } })
    finishWait([done])

    expect(meanwhile.isError, textOf(meanwhile)).toBeFalsy()
    expect(services.remote.mkdir).toHaveBeenCalledWith('/n')
    expect((await del).structuredContent).toMatchObject({ operationId: 'op-remote', done: true })
  })
})

describe('session pin and re-plan (spec §9 R1)', () => {
  it('returns SESSION_CHANGED when the connection changes before an approved or allowed call runs', async () => {
    // covers: Test-605
    const { harness, deps, asked, answer } = wire()
    harness.remote.addDir('/www').addFile('/www/index.html')
    const client = await connectClient(deps)

    // 사용자가 대화상자가 떠 있는 동안 GUI에서 다른 서버에 연결한다
    const other = client.callTool({ name: 'delete', arguments: { paths: ['/www'] } })
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    await harness.remote.connect(GUI_CONNECT)
    answer('approved')
    const switched = await other

    // 같은 서버에 다시 연결해도 다른 세션이다
    const again = client.callTool({ name: 'delete', arguments: { paths: ['/www'] } })
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    await harness.remote.connect(GUI_CONNECT)
    answer('approved')
    const reconnected = await again

    for (const result of [switched, reconnected]) {
      expect(result.isError).toBe(true)
      expect(textOf(result)).toMatch(/^SESSION_CHANGED: /)
      expect(textOf(result)).toContain('get_status')
    }
    expect(harness.remote.deleteDirectory).not.toHaveBeenCalled()
    expect(harness.operations.getAll()).toEqual([])
    expect(deps.notify.activity).toHaveBeenLastCalledWith({
      tool: 'delete',
      tier: 'D',
      outcome: 'failed',
      totalItems: 2
    })

    // 정책 allow: 계획과 실행 사이에 세션이 바뀌어도 실행하지 않는다
    const world = defaultWorld()
    const services = fakeServices(world)
    const allowDeps = makeDeps(services)
    allowDeps.currentPolicy = ALLOW_ALL
    const plan = services.remote.planDelete
    services.remote.planDelete = vi.fn(async (paths: string[]) => {
      await services.session.connect(2)
      return plan(paths)
    })
    const allowClient = await connectClient(allowDeps)
    const allowed = await allowClient.callTool({ name: 'delete', arguments: { paths: ['/a.jpg'] } })

    expect(textOf(allowed)).toMatch(/^SESSION_CHANGED: /)
    expect(services.remote.startDelete).not.toHaveBeenCalled()
  })

  it('returns PLAN_CHANGED when targets change before the user answers, and runs an unchanged plan', async () => {
    // covers: Test-607
    const root = tmpDir()
    const { harness, deps, asked, answer } = wire({
      localFs: new LocalFileSystem(),
      localRoot: root
    })
    harness.remote.addDir('/tmp').addDir('/tmp/empty').addDir('/important')
    harness.remote.addFile('/important/f0').addFile('/gone.txt').addDir('/up')
    const client = await connectClient(deps)
    const call = async (
      name: string,
      args: Record<string, unknown>,
      meanwhile: () => unknown
    ): Promise<string> => {
      const pending = client.callTool({ name, arguments: args })
      await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0))
      asked.length = 0
      await meanwhile()
      answer('approved')
      return textOf(await pending)
    }

    // GUI에서 이름을 맞바꾼다(잠금은 에이전트 호출만 막는다)
    const swapped = await call('delete', { paths: ['/tmp/empty'] }, async () => {
      await harness.remote.rename('/tmp/empty', '/tmp/e2')
      await harness.remote.rename('/important', '/tmp/empty')
    })
    const vanished = await call('delete', { paths: ['/gone.txt'] }, () =>
      harness.remote.nodes.delete('/gone.txt')
    )
    fs.mkdirSync(path.join(root, 'empty'))
    fs.mkdirSync(path.join(root, 'thesis'))
    fs.writeFileSync(path.join(root, 'thesis', 'ch1.tex'), 'x')
    const localSwap = await call('delete_local', { paths: [path.join(root, 'empty')] }, () => {
      fs.renameSync(path.join(root, 'empty'), path.join(root, 'e2'))
      fs.renameSync(path.join(root, 'thesis'), path.join(root, 'empty'))
    })
    fs.writeFileSync(path.join(root, 'a.txt'), 'abc')
    const overwrite = await call(
      'upload',
      { localPaths: [path.join(root, 'a.txt')], remoteDir: '/up', conflict: 'overwrite' },
      () => harness.remote.addFile('/up/a.txt', 3)
    )

    for (const text of [swapped, vanished, localSwap, overwrite]) {
      expect(text).toMatch(/^PLAN_CHANGED: /)
      expect(text).toContain('nothing ran')
      expect(text).toContain('they will be asked again')
    }
    expect(vanished).toContain('Not found on the server: /gone.txt')
    expect(harness.remote.deleteDirectory).not.toHaveBeenCalled()
    expect(harness.remote.deleteFile).not.toHaveBeenCalled()
    expect(harness.queue.enqueueBatch).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(root, 'empty', 'ch1.tex'))).toBe(true)

    // 바뀐 것이 없으면 다시 세운 계획으로 실행한다
    const planDelete = vi.spyOn(deps.services.remote, 'planDelete')
    const unchanged = await call('delete', { paths: ['/tmp/e2'] }, () => undefined)
    expect(unchanged).not.toMatch(/^PLAN_CHANGED/)
    expect(planDelete).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(harness.remote.nodes.has('/tmp/e2')).toBe(false))
  })

  it('tells agents in the instructions and descriptions that calls run one at a time and re-check', async () => {
    // covers: Test-608
    const client = await connectClient(makeDeps())

    const instructions = client.getInstructions() ?? ''
    const { tools } = await client.listTools()
    const disconnect = tools.find((t) => t.name === 'disconnect')?.description ?? ''

    expect(instructions).toContain('Non-read tools run one at a time')
    expect(instructions).toContain('return BUSY at once')
    expect(instructions).toContain('PLAN_CHANGED')
    expect(instructions).toContain('SESSION_CHANGED')
    expect(disconnect).toContain('fails with BUSY while transfers or file operations run')
  })
})

describe('agent folder (spec §9 R2)', () => {
  it('asks before downloading outside the agent folder even when W is allow', async () => {
    // covers: Test-610
    const root = tmpDir()
    const autostart = path.join(tmpDir(), '.config', 'autostart')
    const { harness, deps, asked, answer } = wire({ localRoot: root })
    harness.remote.addFile('/evil.desktop', 10)
    const client = await connectClient(deps)

    const declined = client.callTool({
      name: 'download',
      arguments: { remotePaths: ['/evil.desktop'], localDir: autostart }
    })
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    answer('denied')

    expect(asked[0]).toMatchObject({
      tool: 'download',
      tier: 'W',
      destination: autostart,
      items: [{ path: '/evil.desktop', kind: 'file', size: 10 }]
    })
    expect(textOf(await declined)).toMatch(/^DENIED_BY_USER: /)
    expect(harness.queue.enqueueBatch).not.toHaveBeenCalled()
    expect(fs.existsSync(autostart)).toBe(false)

    const inside = await client.callTool({
      name: 'download',
      arguments: { remotePaths: ['/evil.desktop'], localDir: path.join(root, 'sub') }
    })
    expect(inside.isError).toBeFalsy()
    expect(asked).toHaveLength(1)
    expect(harness.queue.enqueueBatch.mock.calls[0][1][0].localPath).toBe(
      path.join(root, 'sub', 'evil.desktop')
    )

    const approved = client.callTool({
      name: 'download',
      arguments: { remotePaths: ['/evil.desktop'], localDir: autostart }
    })
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    answer('approved')
    expect((await approved).isError).toBeFalsy()
    expect(harness.queue.enqueueBatch.mock.calls[1][1][0].localPath).toBe(
      path.join(autostart, 'evil.desktop')
    )
  })

  it('asks for local folders and renames outside the agent folder, and keeps deny and ask', async () => {
    // covers: Test-611
    const services = fakeServices()
    const deps = makeDeps(services)
    const client = await connectClient(deps)
    const mkdir = (p: string): ReturnType<typeof client.callTool> =>
      client.callTool({ name: 'create_local_directory', arguments: { path: p } })

    await mkdir('/home/u/new')
    expect(deps.confirm).not.toHaveBeenCalled()
    await mkdir('/home/u-evil/x')
    await client.callTool({
      name: 'rename_local',
      arguments: { from: '/home/u', to: '/home/u2' }
    })
    deps.confirm.mockResolvedValue('denied')
    const declined = await mkdir('/etc/cron.d/x')

    expect(deps.confirm.mock.calls.map(([request]) => [request.tool, request.tier])).toEqual([
      ['create_local_directory', 'W'],
      ['rename_local', 'W'],
      ['create_local_directory', 'W']
    ])
    expect(textOf(declined)).toMatch(/^DENIED_BY_USER: /)
    expect(services.local.mkdir).toHaveBeenCalledTimes(2)
    expect(services.local.rename).toHaveBeenCalledWith('/home/u', '/home/u2')

    deps.currentPolicy = { ...deps.currentPolicy, W: 'deny' }
    for (const p of ['/home/u/a', '/etc/x']) {
      expect(textOf(await mkdir(p))).toMatch(/^DENIED_BY_POLICY: /)
    }
    deps.currentPolicy = { ...deps.currentPolicy, W: 'ask' }
    await mkdir('/home/u/b')
    expect(deps.confirm).toHaveBeenCalledTimes(4)
    expect(services.local.mkdir).toHaveBeenCalledTimes(2)
  })

  it('states the agent folder rule in the first description line and in get_status', async () => {
    // covers: Test-613
    const deps = makeDeps()
    const client = await connectClient(deps)

    const { tools } = await client.listTools()
    const status = await client.callTool({ name: 'get_status', arguments: {} })
    deps.currentPolicy = { ...deps.currentPolicy, W: 'ask' }
    const asking = (await client.listTools()).tools

    for (const name of ['download', 'create_local_directory', 'rename_local']) {
      const tool = tools.find((t) => t.name === name)!
      const line = tool.description!.split('\n')[0]
      expect(line, name).toMatch(/^\[RISK W: .+\. Policy: allow — .+\]$/)
      expect(line, name).toContain(
        'Policy: allow — runs without asking the user inside the agent folder /home/u; anywhere ' +
          'else FTP Browser shows the user a confirmation dialog'
      )
      expect(tool._meta, name).toEqual({ 'ftp-browser/risk': 'W', 'ftp-browser/policy': 'allow' })
      expect(tool.annotations?.destructiveHint, name).toBe(false)
      const askLine = asking.find((t) => t.name === name)!.description!.split('\n')[0]
      expect(askLine, name).toContain('Policy: ask — FTP Browser shows the user a confirmation')
    }
    expect(tools.find((t) => t.name === 'create_directory')!.description).not.toContain(
      'agent folder'
    )
    expect(status.structuredContent).toMatchObject({
      agentFolder: {
        path: '/home/u',
        rule:
          'download, create_local_directory and rename_local follow the W policy inside this ' +
          'folder; anywhere else on this computer FTP Browser asks the user first (W policy ' +
          'deny still refuses).'
      }
    })
    expect(client.getInstructions()).toContain('agent folder /home/u')
  })
})

describe('confirmation destination (spec §9 R4)', () => {
  it('names where upload, download and both renames write', async () => {
    // covers: Test-614
    const deps = makeDeps()
    deps.currentPolicy = { W: 'ask', D: 'ask', X: 'ask', C: 'ask' }
    deps.confirm.mockResolvedValue('denied')
    const client = await connectClient(deps)

    await client.callTool({
      name: 'upload',
      arguments: { localPaths: ['/home/u/x.txt'], remoteDir: '/up' }
    })
    await client.callTool({
      name: 'download',
      arguments: { remotePaths: ['/a.jpg'], localDir: '/home/u/dl' }
    })
    await client.callTool({ name: 'rename', arguments: { from: '/a.jpg', to: '/photos/a.jpg' } })
    await client.callTool({
      name: 'rename_local',
      arguments: { from: '/home/u/x.txt', to: '/home/u/y.txt' }
    })

    expect(deps.confirm.mock.calls.map(([request]) => [request.tool, request.destination])).toEqual(
      [
        ['upload', '/up'],
        ['download', '/home/u/dl'],
        ['rename', '/photos/a.jpg'],
        ['rename_local', '/home/u/y.txt']
      ]
    )
  })
})

describe('path rules (spec §9 R5)', () => {
  it('rejects non-normalized remote paths in every tool, including the //uploads recursion', async () => {
    // covers: Test-615
    const { harness, deps } = wire()
    const file = path.join(tmpDir(), 'a.txt')
    fs.writeFileSync(file, 'x')
    harness.remote.addDir('/uploads')
    const client = await connectClient(deps)

    const recursion = await client.callTool({
      name: 'upload',
      arguments: { localPaths: [file], remoteDir: '//uploads', dryRun: true }
    })
    expect(recursion.isError).toBe(true)
    expect(textOf(recursion)).toContain('Use a normalized absolute path')
    expect(textOf(recursion)).not.toContain('call stack')

    const fake = makeDeps()
    fake.currentPolicy = ALLOW_ALL
    const fakeClient = await connectClient(fake)
    const inputs: Array<[string, (p: string) => Record<string, unknown>]> = [
      ['list_directory', (p) => ({ path: p })],
      ['get_image_previews', (p) => ({ paths: [p] })],
      ['connect', (p) => ({ server: 1, path: p })],
      ['create_directory', (p) => ({ path: p })],
      ['rename', (p) => ({ from: p, to: '/b' })],
      ['rename', (p) => ({ from: '/a', to: p })],
      ['delete', (p) => ({ paths: [p] })],
      ['download', (p) => ({ remotePaths: [p], localDir: '/home/u' })],
      ['upload', (p) => ({ localPaths: ['/home/u/x.txt'], remoteDir: p })]
    ]
    for (const bad of ['//uploads', '/a/', '/./a', '/a/..', '/a//b', '/tmp/old/../../www']) {
      for (const [name, args] of inputs) {
        const result = await fakeClient.callTool({ name, arguments: args(bad) })
        expect(result.isError, `${name} ${bad}`).toBe(true)
        expect(textOf(result), `${name} ${bad}`).toContain('Use a normalized absolute path')
      }
    }
    for (const good of ['/', '/.hidden', '/...', '/a b/c.d']) {
      const result = await fakeClient.callTool({
        name: 'list_directory',
        arguments: { path: good }
      })
      expect(textOf(result), good).not.toContain('normalized')
    }
    const services = fake.services
    for (const fn of [
      services.remote.mkdir,
      services.remote.rename,
      services.remote.planDelete,
      services.transfers.planDownload,
      services.transfers.planUpload,
      services.session.connect
    ]) {
      expect(fn).not.toHaveBeenCalled()
    }
  })

  it("rejects '..' segments in local paths in the tools and the services", async () => {
    // covers: Test-617
    const fake = makeDeps()
    fake.currentPolicy = ALLOW_ALL
    const client = await connectClient(fake)
    const calls: Array<[string, Record<string, unknown>]> = [
      ['list_local_directory', { path: '/home/u/..' }],
      ['create_local_directory', { path: '/home/u/../etc/x' }],
      ['rename_local', { from: '/home/u/x.txt', to: '/home/u/../y.txt' }],
      ['delete_local', { paths: ['/home/u/../u2'] }],
      ['download', { remotePaths: ['/a.jpg'], localDir: '/home/u/../.ssh' }],
      ['upload', { localPaths: ['/home/u/../secret'], remoteDir: '/' }]
    ]
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError, name).toBe(true)
      expect(textOf(result), name).toContain("absolute local path without '..' segments")
    }
    expect(fake.services.local.mkdir).not.toHaveBeenCalled()
    expect(fake.services.transfers.planDownload).not.toHaveBeenCalled()

    const harness = createHarness()
    h = harness
    const services = createAgentServices(harness.deps)
    for (const p of ['/tmp/a/../b', '/tmp/a\\..\\b']) {
      await expect(services.local.mkdir(p)).rejects.toMatchObject({ code: 'INVALID_PATH' })
      await expect(services.local.list(p)).rejects.toMatchObject({ code: 'INVALID_PATH' })
      await expect(services.transfers.planDownload(['/a'], p, 'skip')).rejects.toMatchObject({
        code: 'INVALID_PATH'
      })
    }
    expect(harness.deps.localFs.mkdir).not.toHaveBeenCalled()
  })
})

describe('disconnect (spec §9 R8)', () => {
  it('refuses with BUSY while transfers or file operations run', async () => {
    // covers: Test-618
    const { harness, deps } = wire()
    const client = await connectClient(deps)
    const job = harness.queue.add({ status: 'active' })

    const duringTransfer = await client.callTool({ name: 'disconnect', arguments: {} })
    harness.queue.finish(job.id, 'completed')
    const op = harness.operations.create('delete', { itemCount: 1 }, 'files', 1)
    const duringOperation = await client.callTool({ name: 'disconnect', arguments: {} })

    for (const result of [duringTransfer, duringOperation]) {
      expect(result.isError).toBe(true)
      expect(textOf(result)).toMatch(/^BUSY: .*before disconnecting\. /)
      expect(textOf(result)).toContain('wait_for_jobs')
    }
    expect(harness.remote.disconnect).not.toHaveBeenCalled()

    harness.operations.complete(op.id)
    const done = await client.callTool({ name: 'disconnect', arguments: {} })
    expect(done.isError).toBeFalsy()
    expect(harness.remote.disconnect).toHaveBeenCalledTimes(1)
  })
})

describe('confirmation and activity details', () => {
  it('names a handshake client by its User-Agent when the request carries no clientInfo', async () => {
    // covers: Test-619
    const deps = makeDeps()
    deps.confirm.mockResolvedValue('denied')
    const agent = `claude-code/2.1.3\t(external, cli) ${'x'.repeat(80)}`

    const legacy = await connectClient(deps, { name: 'ignored-after-handshake', userAgent: agent })
    await legacy.callTool({ name: 'delete', arguments: { paths: ['/a.jpg'] } })
    const modern = await connectClient(deps, { name: 'agent-x', modern: true, userAgent: agent })
    await modern.callTool({ name: 'delete', arguments: { paths: ['/a.jpg'] } })
    const bare = await connectClient(deps)
    await bare.callTool({ name: 'delete', arguments: { paths: ['/a.jpg'] } })

    const clients = deps.confirm.mock.calls.map(([request]) => request.client)
    expect(clients[0]).toBe(`claude-code/2.1.3 (external, cli) ${'x'.repeat(80)}`.slice(0, 60))
    expect(clients[0]).toHaveLength(60)
    expect(clients[1]).toBe('agent-x')
    expect(clients[2]).toBeUndefined()
    expect('client' in deps.confirm.mock.calls[2][0]).toBe(false)
  })

  it('leaves totalItems out of activity for tools that count nothing', async () => {
    // covers: Test-620
    const world = defaultWorld()
    const deps = makeDeps(fakeServices(world))
    deps.currentPolicy = ALLOW_ALL
    const client = await connectClient(deps)

    await client.callTool({ name: 'connect', arguments: { server: 'Photos', path: '/photos' } })
    await client.callTool({
      name: 'open_server_editor',
      arguments: { host: 'new.example.com', user: 'carol' }
    })
    await client.callTool({ name: 'cancel_jobs', arguments: { ids: 'all' } })
    world.transfers = ['a', 'b'].map((id) => ({
      id,
      direction: 'download' as const,
      localPath: `/home/u/${id}`,
      remotePath: `/${id}`,
      fileName: id,
      totalBytes: 1,
      transferredBytes: 0,
      status: 'active' as const
    }))
    await client.callTool({ name: 'cancel_jobs', arguments: { ids: 'all' } })
    await client.callTool({ name: 'disconnect', arguments: {} })

    expect(deps.notify.activity.mock.calls.map(([activity]) => activity)).toEqual([
      { tool: 'connect', tier: 'W', outcome: 'done' },
      { tool: 'open_server_editor', tier: 'C', outcome: 'done' },
      { tool: 'cancel_jobs', tier: 'W', outcome: 'done' },
      { tool: 'cancel_jobs', tier: 'W', outcome: 'done', totalItems: 2 },
      { tool: 'disconnect', tier: 'W', outcome: 'done' }
    ])
  })
})
