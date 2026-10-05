import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { EXIT, runFtpb, type FtpbIo } from './ftpb'
import { defaultUserDataDir, writeDiscovery } from '../agent/discovery'
import { buildSkillMarkdown } from '@shared/agentClients'
import {
  deadUrl,
  previewBytes,
  startFakeAgentServer,
  type FakeAgentServer
} from './__fixtures__/fakeAgentServer'

let server: FakeAgentServer
let home: string

beforeAll(async () => {
  server = await startFakeAgentServer()
  home = mkdtempSync(join(tmpdir(), 'ftpb-cli-'))
})

afterAll(async () => {
  await server.stop()
  rmSync(home, { recursive: true, force: true })
})

interface Run {
  code: number
  stdout: string
  stderr: string
}

async function ftpb(
  argv: string[],
  options: {
    tty?: boolean
    env?: NodeJS.ProcessEnv
    stdin?: string | NodeJS.ReadableStream
    tmpdir?: string
  } = {}
): Promise<Run> {
  let stdout = ''
  let stderr = ''
  let stdin = options.stdin
  if (typeof stdin === 'string') stdin = new PassThrough().end(stdin)
  const io: FtpbIo = {
    env: options.env ?? { FTPB_URL: server.url, FTPB_TOKEN: server.token },
    platform: 'linux',
    home,
    tmpdir: options.tmpdir ?? join(home, 'tmp'),
    // Never ends: a command that reads stdin when it should not hangs the test.
    stdin: stdin ?? new PassThrough(),
    stdout: {
      isTTY: options.tty ?? false,
      write: (chunk: string) => {
        stdout += chunk
        return true
      }
    },
    stderr: {
      write: (chunk: string) => {
        stderr += chunk
        return true
      }
    },
    fetch: globalThis.fetch,
    self: { command: '/usr/bin/node', args: ['/opt/ftpb.cjs'] }
  }
  const code = await runFtpb(argv, io)
  return { code, stdout, stderr }
}

describe('ftpb discovery', () => {
  it('reads the endpoint from the userData discovery files when no env is set', async () => {
    // covers: Test-550
    const userData = defaultUserDataDir('linux', {}, home)
    const pid = process.pid
    writeDiscovery(userData, { url: server.url, token: server.token, pid, version: '9.9.9' })

    const run = await ftpb(['status'], { env: {} })

    expect(run).toMatchObject({ code: EXIT.OK, stderr: '' })
    expect(JSON.parse(run.stdout)).toMatchObject({
      endpoint: { url: server.url, version: '9.9.9', pid },
      connection: { status: 'connected', host: 'nas.local' }
    })
    rmSync(join(userData, 'agent'), { recursive: true, force: true })
  })

  it('lets FTPB_URL and FTPB_TOKEN override the files', async () => {
    // covers: Test-550
    const userData = defaultUserDataDir('linux', {}, home)
    writeDiscovery(userData, { url: await deadUrl(), token: 'stale', pid: 1, version: '1' })

    const run = await ftpb(['get_status'], {
      env: { FTPB_URL: server.url, FTPB_TOKEN: server.token }
    })

    expect(run.code).toBe(EXIT.OK)
    rmSync(join(userData, 'agent'), { recursive: true, force: true })
  })

  it('exits 4 and tells the user to start the app when nothing is discovered', async () => {
    // covers: Test-550
    const run = await ftpb(['status'], { env: {} })

    expect(run.code).toBe(EXIT.UNAVAILABLE)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('Start FTP Browser and turn on Agent access')
  })
})

describe('ftpb tools', () => {
  it('lists every tool with its risk tier and current policy as JSON', async () => {
    // covers: Test-551
    const run = await ftpb(['tools'])

    expect(run.code).toBe(EXIT.OK)
    const { tools } = JSON.parse(run.stdout) as {
      tools: Array<{ name: string; tier: string; policy: string; inputSchema: unknown }>
    }
    expect(tools.map((t) => [t.name, t.tier, t.policy])).toEqual([
      ['get_status', 'R', 'allow'],
      ['list_directory', 'R', 'allow'],
      ['delete', 'D', 'ask'],
      ['wait_for_jobs', 'R', 'allow'],
      ['connect', 'W', 'allow'],
      ['get_image_previews', 'R', 'allow']
    ])
    expect(tools[1].inputSchema).toMatchObject({ properties: { path: { type: 'string' } } })
  })

  it('prints a table with tier and policy on a terminal', async () => {
    // covers: Test-551
    const run = await ftpb(['tools'], { tty: true })

    expect(run.code).toBe(EXIT.OK)
    const rows = run.stdout.split('\n')
    expect(rows[0]).toMatch(/^TIER\s+POLICY\s+TOOL\s+TITLE/)
    expect(rows.find((r) => r.includes('delete'))).toMatch(
      /^D\s+ask\s+delete\s+Delete remote files/
    )
    expect(run.stdout).toContain('--help')
  })

  it("shows a tool's flags from its input schema with --help", async () => {
    // covers: Test-551
    const run = await ftpb(['list-directory', '--help'], { tty: true })

    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toContain('list_directory')
    expect(run.stdout).toMatch(/--path <string>\s+required/)
    expect(run.stdout).toMatch(/--limit <integer>/)
    expect(run.stdout).toMatch(/--kind <all\|files\|directories>/)
    expect(run.stdout).toMatch(/--names <string> \(repeatable\)/)
  })
})

describe('ftpb call and tool sugar', () => {
  it('builds the same arguments from --args JSON and from typed flags', async () => {
    // covers: Test-552
    const expected = {
      path: '/photos',
      limit: 5,
      recursive: true,
      names: ['a.jpg', 'b c.jpg'],
      sizes: [1, 2.5],
      filter: { minSize: 10 }
    }
    server.calls.length = 0

    const viaCall = await ftpb(['call', 'list_directory', '--args', JSON.stringify(expected)])
    const viaSugar = await ftpb([
      'list-directory',
      '--path',
      '/photos',
      '--limit',
      '5',
      '--recursive',
      '--names',
      'a.jpg',
      '--names=b c.jpg',
      '--sizes',
      '[1,2.5]',
      '--filter',
      '{"minSize":10}'
    ])
    const viaSnake = await ftpb(['list_directory', '--args', '{"path":"/x"}', '--path', '/photos'])

    expect([viaCall.code, viaSugar.code, viaSnake.code]).toEqual([0, 0, 0])
    expect(server.calls.map((c) => c.args)).toEqual([expected, expected, { path: '/photos' }])
    expect(JSON.parse(viaSugar.stdout)).toEqual({ received: expected })
  })

  it('maps --dry-run and --no-<flag> onto boolean parameters', async () => {
    // covers: Test-552
    server.calls.length = 0

    const run = await ftpb(['call', 'delete', '--paths', '/a', '--dry-run'])
    await ftpb(['list-directory', '--path', '/', '--no-recursive'])
    await ftpb(['list-directory', '--path', '/', '--recursive', 'false'])
    await ftpb(['list-directory', '--path', '/', '--names', '[2024] trip.jpg'])

    expect(run.code).toBe(EXIT.OK)
    expect(server.calls.map((c) => c.args)).toEqual([
      { paths: ['/a'], dryRun: true },
      { path: '/', recursive: false },
      { path: '/', recursive: false },
      { path: '/', names: ['[2024] trip.jpg'] }
    ])
  })
})

describe('ftpb exit codes', () => {
  it('maps success, tool errors, usage, refusals and an unreachable app to 0–4', async () => {
    // covers: Test-553
    expect((await ftpb(['get-status'])).code).toBe(0)
    expect((await ftpb(['delete', '--paths', '/fail'])).code).toBe(1)
    expect((await ftpb(['list-directory', '--bogus', '1'])).code).toBe(2)
    expect((await ftpb(['list-directory', '--limit', 'many', '--path', '/'])).code).toBe(2)
    expect((await ftpb(['list-directory', '--path'])).code).toBe(2)
    expect((await ftpb(['no-such-tool'])).code).toBe(2)
    expect((await ftpb(['call'])).code).toBe(2)
    expect((await ftpb(['delete', '--paths', '/denied'])).code).toBe(3)
    expect((await ftpb(['delete', '--paths', '/timeout'])).code).toBe(3)
    const wrongToken = { FTPB_URL: server.url, FTPB_TOKEN: 'wrong' }
    expect((await ftpb(['get-status'], { env: wrongToken })).code).toBe(4)
    const dead = { FTPB_URL: await deadUrl(), FTPB_TOKEN: server.token }
    expect((await ftpb(['get-status'], { env: dead })).code).toBe(4)
  })

  it('treats an argument the input schema rejects as a usage error', async () => {
    // covers: Test-553
    const run = await ftpb(['wait-for-jobs', '--ids', 'j1', '--timeout-sec', '90'])

    expect(run.code).toBe(EXIT.USAGE)
    expect(run.stderr).toMatch(/timeoutSec/)
  })

  it('still calls a tool hidden by policy so the app can answer DENIED_BY_POLICY', async () => {
    // covers: Test-553
    const viaJson = await ftpb(['delete-local', '--paths', '["/tmp/a"]'])
    const viaArgs = await ftpb(['call', 'delete_local', '--args', '{"paths":["/tmp/a"]}'])
    // Without a listed schema flag values stay strings; the schema error then says why.
    const untyped = await ftpb(['delete-local', '--paths', '/tmp/a'])

    expect([viaJson.code, viaArgs.code]).toEqual([EXIT.DENIED, EXIT.DENIED])
    expect(JSON.parse(viaJson.stderr).error.code).toBe('DENIED_BY_POLICY')
    expect(untyped.code).toBe(EXIT.USAGE)
    expect(untyped.stderr).toContain('delete_local is not in `ftpb tools`')
  })

  it('lists the exit codes and tiers in --help', async () => {
    // covers: Test-553
    const run = await ftpb(['--help'])

    expect(run.code).toBe(EXIT.OK)
    for (const line of [/^\s+0\s/m, /^\s+1\s/m, /^\s+2\s/m, /^\s+3\s/m, /^\s+4\s/m])
      expect(run.stdout).toMatch(line)
    expect(run.stdout).toContain('DENIED_BY_USER')
    for (const tier of ['R ', 'W ', 'D ', 'X ', 'C ']) expect(run.stdout).toContain(tier)
  })
})

describe('ftpb output', () => {
  it('writes compact JSON when stdout is not a terminal and readable text on one', async () => {
    // covers: Test-554
    const piped = await ftpb(['get-status'])
    const tty = await ftpb(['get-status'], { tty: true })
    const forced = await ftpb(['get-status', '--json'], { tty: true })

    expect(piped.stdout).toBe('{"connection":{"status":"connected","host":"nas.local"}}\n')
    expect(forced.stdout).toBe(piped.stdout)
    expect(tty.stdout).not.toBe(piped.stdout)
    expect(tty.stdout).toContain('nas.local')
    expect(tty.stdout.split('\n').length).toBeGreaterThan(3)
  })

  it('puts errors on stderr and nothing on stdout', async () => {
    // covers: Test-554
    const denied = await ftpb(['delete', '--paths', '/denied'])
    const usage = await ftpb(['list-directory', '--bogus', '1'], { tty: true })

    expect(denied.stdout).toBe('')
    expect(JSON.parse(denied.stderr)).toEqual({
      error: {
        code: 'DENIED_BY_USER',
        message: 'DENIED_BY_USER: The user declined in FTP Browser. Do not retry.'
      }
    })
    expect(usage.stdout).toBe('')
    expect(usage.stderr).toMatch(/^ftpb: Unknown parameter --bogus/)
    expect(usage.stderr).toContain('--path')
  })
})

describe('ftpb auth', () => {
  it('prints the Claude Code headersHelper JSON, the header value and the raw token', async () => {
    // covers: Test-555
    const header = await ftpb(['auth', 'header'], { tty: true })
    const value = await ftpb(['auth', 'header', '--value'])
    const token = await ftpb(['auth', 'token'])

    expect(header).toEqual({
      code: 0,
      stdout: `{"Authorization":"Bearer ${server.token}"}\n`,
      stderr: ''
    })
    expect(value.stdout).toBe(`Bearer ${server.token}\n`)
    expect(token.stdout).toBe(`${server.token}\n`)
  })

  it('exits 4 without printing anything when there is no token', async () => {
    // covers: Test-555
    const run = await ftpb(['auth', 'header'], { env: {} })

    expect(run.code).toBe(EXIT.UNAVAILABLE)
    expect(run.stdout).toBe('')
  })
})

describe('ftpb setup and skill', () => {
  it('prints a client snippet on stdout and its notes on stderr', async () => {
    // covers: Test-568
    const run = await ftpb(['setup', 'claude-code'], { tty: true })

    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toContain(`"url":"${server.url}"`)
    expect(run.stdout).toContain('"headersHelper":"ftpb auth header"')
    expect(run.stderr).toContain('headersHelper')
    const json = await ftpb(['setup', 'cursor'])
    expect(JSON.parse(json.stdout)).toMatchObject({ id: 'cursor', kind: 'stdio' })
    const list = await ftpb(['setup', '--list'], { tty: true })
    expect(list.stdout).toMatch(/^claude-code\s+http\s+Claude Code$/m)
    expect((await ftpb(['setup', 'nope'])).code).toBe(EXIT.USAGE)
  })

  it('installs the skill into a given folder', async () => {
    // covers: Test-568
    const dir = join(home, 'skills')

    const run = await ftpb(['skill', 'install', '--dir', dir])

    expect(run.code).toBe(EXIT.OK)
    expect(JSON.parse(run.stdout)).toEqual({ paths: [join(dir, 'ftp-browser', 'SKILL.md')] })
  })
})

/** The text of `text` from the line matching `from` up to the line matching `to`. */
function section(text: string, from: RegExp, to: RegExp): string {
  const start = text.search(from)
  expect(start).toBeGreaterThanOrEqual(0)
  const rest = text.slice(start)
  const body = rest.indexOf('\n') + 1
  const end = rest.slice(body).search(to)
  return end < 0 ? rest : rest.slice(0, body + end)
}

describe('ftpb --args - (JSON arguments on stdin)', () => {
  it('reads the arguments from stdin for call and for the tool sugar', async () => {
    // covers: Test-637
    const name = `a "b" & c | d %PATH% ^e !f\n'g'.jpg`
    const args = { path: '/photos', names: [name], limit: 5 }
    server.calls.length = 0

    const viaCall = await ftpb(['call', 'list_directory', '--args', '-'], {
      stdin: JSON.stringify(args)
    })
    const viaSugar = await ftpb(['list-directory', '--args=-', '--limit', '7'], {
      stdin: `${JSON.stringify(args, null, 2)}\n`
    })

    expect([viaCall.code, viaSugar.code]).toEqual([EXIT.OK, EXIT.OK])
    expect(server.calls.map((c) => c.args)).toEqual([args, { ...args, limit: 7 }])
  })

  it('exits 2 when stdin holds no JSON object, without echoing it or waiting on a terminal', async () => {
    // covers: Test-638
    server.calls.length = 0
    const call = ['call', 'list_directory', '--args', '-']

    const notJson = await ftpb(call, { stdin: 'remote name & more' })
    const array = await ftpb(call, { stdin: '["/a"]' })
    const empty = await ftpb(call, { stdin: '' })
    const tty = await ftpb(call, { stdin: Object.assign(new PassThrough(), { isTTY: true }) })

    expect([notJson.code, array.code, empty.code, tty.code]).toEqual([2, 2, 2, 2])
    expect(notJson.stderr).not.toContain('remote name')
    for (const run of [notJson, array, empty])
      expect(JSON.parse(run.stderr).error.message).toContain(
        '--args - needs a JSON object on stdin'
      )
    expect(JSON.parse(tty.stderr).error.message).toContain('stdin is a terminal')
    expect(server.calls).toEqual([])
  })

  it('tells agents to pass untrusted strings as JSON on stdin in --help and the README', async () => {
    // covers: Test-639
    const help = (await ftpb(['--help'])).stdout
    const toolHelp = (await ftpb(['list-directory', '--help'])).stdout
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8')
    const agents = section(readme, /^## 에이전트 연동/m, /^## /m)

    expect(help).toContain("ftpb call <tool> [--args '<json>' | --args -]")
    for (const text of [help, agents]) {
      expect(text).toContain('--args -')
      expect(text).toMatch(/untrusted|신뢰할 수 없는/)
      expect(text).toContain('Windows')
    }
    expect(toolHelp).toContain('--args -')
  })
})

describe('ftpb refusals and errors to retry', () => {
  it('exits 3 for CONFIRMATION_CANCELLED and 1 for BUSY, SESSION_CHANGED and PLAN_CHANGED', async () => {
    // covers: Test-640
    const cases = [
      ['/cancelled', 'CONFIRMATION_CANCELLED', EXIT.DENIED],
      ['/busy', 'BUSY', EXIT.TOOL_ERROR],
      ['/session-changed', 'SESSION_CHANGED', EXIT.TOOL_ERROR],
      ['/plan-changed', 'PLAN_CHANGED', EXIT.TOOL_ERROR]
    ] as const

    for (const [path, code, exit] of cases) {
      const run = await ftpb(['delete', '--paths', path])
      expect([JSON.parse(run.stderr).error.code, run.code]).toEqual([code, exit])
    }
  })

  it('explains in --help which codes exit 1 or 3, what to do, and the local write rule', async () => {
    // covers: Test-641
    const help = (await ftpb(['--help'])).stdout
    const exits = section(help, /^Exit codes:/m, /^\S/m)
    const exit1 = section(exits, /^ {2}1 {2}/m, /^ {2}2 {2}/m)
    const exit3 = section(exits, /^ {2}3 {2}/m, /^ {2}4 {2}/m)

    for (const code of ['BUSY', 'SESSION_CHANGED', 'PLAN_CHANGED']) expect(exit1).toContain(code)
    expect(exit1).toMatch(/retry after the user answers/)
    expect(exit1).toMatch(/run it again/)
    for (const code of [
      'DENIED_BY_POLICY',
      'DENIED_BY_USER',
      'CONFIRMATION_TIMEOUT',
      'CONFIRMATION_UNAVAILABLE',
      'CONFIRMATION_CANCELLED'
    ])
      expect(exit3).toContain(code)
    expect(help).toMatch(/outside (the user's|your) Downloads folder/)
  })
})

describe('ftpb stale discovery files', () => {
  let listener: Server
  let listenerUrl: string
  let hits = 0
  const userData = (): string => defaultUserDataDir('linux', {}, home)

  beforeAll(async () => {
    listener = createServer((_req, res) => {
      hits++
      res.writeHead(500).end()
    })
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    listenerUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`
  })

  afterAll(async () => {
    await new Promise((resolve) => listener.close(resolve))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(join(userData(), 'agent'), { recursive: true, force: true })
    hits = 0
  })

  /** The pid of a process that has already exited. */
  function deadPid(): number {
    const { pid } = spawnSync(process.execPath, ['-e', ''])
    expect(pid).toBeGreaterThan(0)
    return pid as number
  }

  it('does not send the token when the app that wrote endpoint.json is gone', async () => {
    // covers: Test-643
    writeDiscovery(userData(), {
      url: listenerUrl,
      token: 'leftover',
      pid: deadPid(),
      version: '1'
    })

    const runs = [
      await ftpb(['status'], { env: {} }),
      await ftpb(['list-directory', '--path', '/'], { env: {} }),
      await ftpb(['auth', 'header'], { env: {} }),
      await ftpb(['auth', 'token'], { env: {} })
    ]

    for (const run of runs) {
      expect(run.code).toBe(EXIT.UNAVAILABLE)
      expect(run.stdout).toBe('')
      expect(JSON.parse(run.stderr).error.message).toMatch(
        /^Stale discovery file.*Start FTP Browser and turn on Agent access/
      )
    }
    expect(hits).toBe(0)
  })

  it('answers mcp-stdio requests with an error instead of relaying them to a stale endpoint', async () => {
    // covers: Test-643
    writeDiscovery(userData(), {
      url: listenerUrl,
      token: 'leftover',
      pid: deadPid(),
      version: '1'
    })
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/list' }

    const run = await ftpb(['mcp-stdio'], { env: {}, stdin: `${JSON.stringify(request)}\n` })

    expect(run.code).toBe(EXIT.OK)
    expect(JSON.parse(run.stdout)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: expect.stringMatching(/^Stale discovery file/) }
    })
    expect(run.stderr).toContain('Stale discovery file')
    expect(hits).toBe(0)
  })

  it("goes ahead when the pid is alive, or when kill answers EPERM (another user's process)", async () => {
    // covers: Test-643
    writeDiscovery(userData(), {
      url: server.url,
      token: server.token,
      pid: process.pid,
      version: '1'
    })
    const alive = await ftpb(['get-status'], { env: {} })
    const pid = deadPid()
    writeDiscovery(userData(), { url: server.url, token: server.token, pid, version: '1' })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    })
    const eperm = await ftpb(['get-status'], { env: {} })

    expect([alive.code, eperm.code]).toEqual([EXIT.OK, EXIT.OK])
    expect(kill).toHaveBeenCalledWith(pid, 0)
  })

  it('skips the pid check when FTPB_URL is set, but not for FTPB_TOKEN alone', async () => {
    // covers: Test-644
    writeDiscovery(userData(), {
      url: listenerUrl,
      token: server.token,
      pid: deadPid(),
      version: '1'
    })

    const both = await ftpb(['get-status'], {
      env: { FTPB_URL: server.url, FTPB_TOKEN: server.token }
    })
    const urlOnly = await ftpb(['get-status'], { env: { FTPB_URL: server.url } })
    const tokenOnly = await ftpb(['get-status'], { env: { FTPB_TOKEN: server.token } })

    expect([both.code, urlOnly.code, tokenOnly.code]).toEqual([EXIT.OK, EXIT.OK, EXIT.UNAVAILABLE])
    expect(tokenOnly.stderr).toContain('Stale discovery file')
    expect(hits).toBe(0)
  })
})

describe('ftpb union parameters', () => {
  it('sends a saved server name as a string and an id as a number to connect', async () => {
    // covers: Test-690
    server.calls.length = 0

    const byName = await ftpb(['connect', '--server', 'Pixel phone'])
    const byId = await ftpb(['connect', '--server', '1', '--dry-run'])
    const byHost = await ftpb(['connect', '--server=192.168.0.7'])
    const help = await ftpb(['connect', '--help'], { tty: true })

    expect([byName.code, byId.code, byHost.code]).toEqual([EXIT.OK, EXIT.OK, EXIT.OK])
    expect(server.calls.map((c) => c.args)).toEqual([
      { server: 'Pixel phone' },
      { server: 1, dryRun: true },
      { server: '192.168.0.7' }
    ])
    expect(help.stdout).toMatch(/--server <integer\|string>\s+required/)
  })

  it('names the accepted forms and --args - in a conversion error, and sends nothing', async () => {
    // covers: Test-692
    server.calls.length = 0

    const run = await ftpb(['list-directory', '--path', '/', '--limit', 'many'])

    expect(run.code).toBe(EXIT.USAGE)
    const { message } = JSON.parse(run.stderr).error as { message: string }
    expect(message).toMatch(/^--limit needs an integer, got "many"\./)
    expect(message).toContain('--args -')
    expect(server.calls).toEqual([])
  })
})

describe('ftpb image blocks', () => {
  const saveDir = (name: string): string => join(home, 'previews', name)

  it('saves each image block as a file named after its preview path and prints no base64', async () => {
    // covers: Test-693
    const dir = saveDir('693')
    const paths = ['/DCIM/IMG_0912.jpg', '/DCIM/notes.txt', '/shots/Screen shot.png']
    server.calls.length = 0

    const run = await ftpb([
      'get-image-previews',
      ...paths.flatMap((path) => ['--paths', path]),
      '--save-dir',
      dir
    ])

    expect(run).toMatchObject({ code: EXIT.OK, stderr: '' })
    expect(JSON.parse(run.stdout)).toEqual({
      structuredContent: {
        previews: [
          { path: paths[0], ok: true },
          { path: paths[1], ok: false, error: 'Not an image file.' },
          { path: paths[2], ok: true }
        ]
      },
      content: [
        {
          type: 'image',
          mimeType: 'image/jpeg',
          path: paths[0],
          savedTo: join(dir, 'IMG_0912.jpg')
        },
        {
          type: 'image',
          mimeType: 'image/jpeg',
          path: paths[2],
          savedTo: join(dir, 'Screen shot.jpg')
        }
      ]
    })
    expect(readFileSync(join(dir, 'IMG_0912.jpg'))).toEqual(previewBytes(paths[0]))
    expect(readFileSync(join(dir, 'Screen shot.jpg'))).toEqual(previewBytes(paths[2]))
    expect(run.stdout).not.toContain(previewBytes(paths[0]).toString('base64'))
    expect(server.calls.map((c) => c.args)).toEqual([{ paths }])
  })

  it('uses index names without a mapping, keeps hostile names inside the folder and never overwrites', async () => {
    // covers: Test-694
    const dir = join(saveDir('694'), 'out')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'IMG_1.jpg'), 'the user file')
    const paths = [
      '/a/IMG_1.jpg',
      '/b/IMG_1.JPG',
      '/x/..\\..\\evil\u0007.jpg',
      '/x/CON.jpg',
      '/x/a\u200Bb.jpg',
      '/x/.jpg'
    ]

    const mapped = await ftpb(['call', 'get_image_previews', '--args', '-', '--save-dir', dir], {
      stdin: JSON.stringify({ paths })
    })
    const unmapped = await ftpb([
      'get-image-previews',
      '--paths',
      '/a/IMG_1.jpg',
      '--paths',
      '/b/c.jpg',
      '--no-mapped',
      '--save-dir',
      dir
    ])

    expect([mapped.code, unmapped.code]).toEqual([EXIT.OK, EXIT.OK])
    const saved = (run: Run): string[] =>
      (JSON.parse(run.stdout) as { content: Array<{ savedTo: string }> }).content.map(
        (block) => block.savedTo
      )
    expect(saved(mapped)).toEqual(
      ['IMG_1-2.jpg', 'IMG_1-3.jpg', '_.._evil_.jpg', '_CON.jpg', 'a_b.jpg', 'image-6.jpg'].map(
        (name) => join(dir, name)
      )
    )
    expect(JSON.parse(unmapped.stdout)).toEqual({
      content: [
        { type: 'image', mimeType: 'image/jpeg', savedTo: join(dir, 'image-1.jpg') },
        { type: 'image', mimeType: 'image/jpeg', savedTo: join(dir, 'image-2.jpg') }
      ]
    })
    expect(readFileSync(join(dir, 'IMG_1.jpg'), 'utf8')).toBe('the user file')
    expect(readFileSync(join(dir, 'IMG_1-2.jpg'))).toEqual(previewBytes(paths[0]))
    expect(readFileSync(join(dir, 'image-2.jpg'))).toEqual(previewBytes('/b/c.jpg'))
    expect(readdirSync(saveDir('694'))).toEqual(['out'])
    expect(readdirSync(dir).sort()).toEqual(
      [
        'IMG_1.jpg',
        'IMG_1-2.jpg',
        'IMG_1-3.jpg',
        '_.._evil_.jpg',
        '_CON.jpg',
        'a_b.jpg',
        'image-6.jpg',
        'image-1.jpg',
        'image-2.jpg'
      ].sort()
    )
  })

  it('saves to <tmpdir>/ftpb-previews by default, lists the files on a terminal, and prints the result as sent with --raw', async () => {
    // covers: Test-695
    const tmp = mkdtempSync(join(home, 'tmp-695-'))
    const defaultDir = join(tmp, 'ftpb-previews')

    const piped = await ftpb(['get-image-previews', '--paths', '/DCIM/a.jpg'], { tmpdir: tmp })
    const tty = await ftpb(['get-image-previews', '--paths', '/DCIM/b.jpg'], {
      tmpdir: tmp,
      tty: true
    })
    const rawDir = join(tmp, 'raw')
    const raw = await ftpb(
      ['get-image-previews', '--paths', '/DCIM/c.jpg', '--raw', '--save-dir', rawDir],
      { tmpdir: tmp }
    )

    expect([piped.code, tty.code, raw.code]).toEqual([EXIT.OK, EXIT.OK, EXIT.OK])
    expect(JSON.parse(piped.stdout).content[0].savedTo).toBe(join(defaultDir, 'a.jpg'))
    expect(readFileSync(join(defaultDir, 'a.jpg'))).toEqual(previewBytes('/DCIM/a.jpg'))
    if (process.platform !== 'win32') expect(statSync(defaultDir).mode & 0o777).toBe(0o700)
    expect(tty.stdout).toContain(join(defaultDir, 'b.jpg'))
    expect(tty.stdout).not.toContain(previewBytes('/DCIM/b.jpg').toString('base64'))
    const sent = JSON.parse(raw.stdout) as { content: Array<{ type: string; data?: string }> }
    expect(sent.content.map((block) => block.type)).toEqual(['text', 'image'])
    expect(sent.content[1].data).toBe(previewBytes('/DCIM/c.jpg').toString('base64'))
    expect(existsSync(rawDir)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    "refuses a default folder that is a symlink or another user's, and points to --save-dir",
    async () => {
      // covers: Test-695
      const tmp = mkdtempSync(join(home, 'tmp-695-link-'))
      const elsewhere = join(tmp, 'elsewhere')
      mkdirSync(elsewhere)
      symlinkSync(elsewhere, join(tmp, 'ftpb-previews'))
      const theirs = mkdtempSync(join(home, 'tmp-695-theirs-'))
      mkdirSync(join(theirs, 'ftpb-previews'))

      const linked = await ftpb(['get-image-previews', '--paths', '/DCIM/a.jpg'], { tmpdir: tmp })
      const uid = vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1)
      const owned = await ftpb(['get-image-previews', '--paths', '/DCIM/a.jpg'], {
        tmpdir: theirs
      })
      uid.mockRestore()

      for (const run of [linked, owned]) {
        expect(run.code).toBe(EXIT.TOOL_ERROR)
        expect(run.stdout).toBe('')
        expect(JSON.parse(run.stderr).error.message).toContain('--save-dir')
      }
      expect(readdirSync(elsewhere)).toEqual([])
      expect(readdirSync(join(theirs, 'ftpb-previews'))).toEqual([])
    }
  )

  it('prints the data once and documents the JSON shape, --save-dir and --raw', async () => {
    // covers: Test-696
    const run = await ftpb(['get-image-previews', '--paths', '/DCIM/a.jpg'], {
      tmpdir: mkdtempSync(join(home, 'tmp-696-'))
    })
    const help = (await ftpb(['--help'])).stdout
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8')
    const agents = section(readme, /^## 에이전트 연동/m, /^## /m)

    const value = JSON.parse(run.stdout) as { content: Array<{ type: string }> }
    expect(value.content.map((block) => block.type)).toEqual(['image'])
    expect(run.stdout.split('"previews"')).toHaveLength(2)
    const output = section(help, /^Output/m, /^$/m)
    expect(output).toContain('structuredContent')
    expect(output).toContain('--save-dir <dir>')
    expect(output).toContain('ftpb-previews')
    expect(output).toContain('--raw')
    expect(agents).toContain('--save-dir')
    expect(agents).toContain('--raw')
  })
})

describe('ftpb --help example', () => {
  it('walks through connect by name, list, dry run, download, wait and check', async () => {
    // covers: Test-697
    const help = (await ftpb(['--help'])).stdout
    const example = section(help, /^Example/m, /^\S/m)

    const steps = [
      'ftpb connect --server "Pixel phone"',
      'ftpb list-directory',
      'ftpb download --dry-run --args -',
      'ftpb wait-for-jobs --ids',
      'ftpb list-local-directory'
    ].map((step) => example.indexOf(step))
    expect(steps.every((at) => at >= 0)).toBe(true)
    expect([...steps].sort((a, b) => a - b)).toEqual(steps)
    // a long command goes on with a shell line continuation, as the user would type it
    expect(example).toMatch(/ \\\n\s+--modified-from /)
  })

  it('filters the day like SKILL.md and says how long a confirmation dialog waits', async () => {
    // covers: Test-700
    const help = (await ftpb(['--help'])).stdout
    const example = section(help, /^Example/m, /^\S/m)
    const range = /--modified-from \S+ --modified-to \S+/

    expect(range.exec(example)?.[0]).toBe('--modified-from 2026-09-12 --modified-to 2026-09-12')
    expect(range.exec(buildSkillMarkdown({ ftpbCommand: 'ftpb' }))?.[0]).toBe(
      range.exec(example)?.[0]
    )
    expect(example).toMatch(/whole UTC day/)
    expect(example).toMatch(/MLSD/)
    expect(example).toMatch(/names[^]*local time/)
    expect(help).not.toMatch(/T00:00:00Z|T23:59:59Z/)
    const tiers = section(help, /^Risk tiers/m, /^\S/m)
    expect(tiers).toMatch(/120 seconds/)
    expect(tiers).toContain('CONFIRMATION_TIMEOUT')
    expect(tiers).toMatch(/at least 130 s/)
    expect(tiers).toMatch(/--dry-run never waits/)
  })
})
