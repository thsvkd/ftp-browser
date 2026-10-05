import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { EXIT, runFtpb, type FtpbIo } from './ftpb'
import { defaultUserDataDir, writeDiscovery } from '../agent/discovery'
import { deadUrl, startFakeAgentServer, type FakeAgentServer } from './__fixtures__/fakeAgentServer'

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
  options: { tty?: boolean; env?: NodeJS.ProcessEnv } = {}
): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const io: FtpbIo = {
    env: options.env ?? { FTPB_URL: server.url, FTPB_TOKEN: server.token },
    platform: 'linux',
    home,
    stdin: new PassThrough(),
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
    writeDiscovery(userData, { url: server.url, token: server.token, pid: 1, version: '9.9.9' })

    const run = await ftpb(['status'], { env: {} })

    expect(run).toMatchObject({ code: EXIT.OK, stderr: '' })
    expect(JSON.parse(run.stdout)).toMatchObject({
      endpoint: { url: server.url, version: '9.9.9', pid: 1 },
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
      ['wait_for_jobs', 'R', 'allow']
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
