import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'child_process'
import {
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
import { defaultUserDataDir, writeDiscovery } from '../mcp/discovery'
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
  options: { env?: NodeJS.ProcessEnv; stdin?: string | FtpbIo['stdin']; tmpdir?: string } = {}
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
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    fetch: globalThis.fetch
  }
  const code = await runFtpb(argv, io)
  return { code, stdout, stderr }
}

const errorOf = (run: Run): { code: string; message: string } => JSON.parse(run.stderr).error

/** The text of `text` from the line matching `from` up to the line matching `to`. */
function section(text: string, from: RegExp, to: RegExp): string {
  const start = text.search(from)
  expect(start).toBeGreaterThanOrEqual(0)
  const rest = text.slice(start)
  const body = rest.indexOf('\n') + 1
  const end = rest.slice(body).search(to)
  return end < 0 ? rest : rest.slice(0, body + end)
}

describe('ftpb discovery', () => {
  it('reads the endpoint from the userData discovery files, lets FTPB_URL and FTPB_TOKEN override them, and exits 4 without either', async () => {
    // covers: Test-550
    const userData = defaultUserDataDir('linux', {}, home)
    writeDiscovery(userData, {
      url: server.url,
      token: server.token,
      pid: process.pid,
      version: '9'
    })
    const fromFiles = await ftpb(['get-status'], { env: {} })
    writeDiscovery(userData, {
      url: await deadUrl(),
      token: 'stale',
      pid: process.pid,
      version: '1'
    })
    const fromEnv = await ftpb(['get_status'])
    rmSync(join(userData, 'agent'), { recursive: true, force: true })
    const nothing = await ftpb(['get-status'], { env: {} })

    expect(fromFiles).toMatchObject({ code: EXIT.OK, stderr: '' })
    expect(JSON.parse(fromFiles.stdout)).toEqual({
      connection: { status: 'connected', host: 'nas.local' }
    })
    expect(fromEnv.code).toBe(EXIT.OK)
    expect(nothing).toMatchObject({ code: EXIT.UNAVAILABLE, stdout: '' })
    expect(errorOf(nothing).message).toContain('Start FTP Browser and turn on Agent access')
  })
})

describe('ftpb tools and --help', () => {
  it('lists every tool with its risk line, description and input schema as JSON', async () => {
    // covers: Test-551
    const run = await ftpb(['tools'])

    expect(run.code).toBe(EXIT.OK)
    const { tools } = JSON.parse(run.stdout) as {
      tools: Array<{ name: string; risk: string; description: string; inputSchema: unknown }>
    }
    expect(tools.map((t) => [t.name, t.risk])).toEqual([
      ['get_status', '[RISK: read-only]'],
      ['list_directory', '[RISK: read-only]'],
      ['delete', '[RISK: DESTRUCTIVE — permanently deletes; FTP has no trash]'],
      ['wait_for_jobs', '[RISK: read-only]'],
      ['connect', '[RISK: changes state, no data loss]'],
      ['get_image_previews', '[RISK: read-only]']
    ])
    expect(tools[1].description).toBe('List a directory.')
    expect(tools[1].inputSchema).toMatchObject({ properties: { path: { type: 'string' } } })
  })

  it("shows a tool's description and flags from its input schema with --help", async () => {
    // covers: Test-551
    const run = await ftpb(['list-directory', '--help'])

    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toMatch(/^ftpb list-directory\n/)
    expect(run.stdout).toContain('[RISK: read-only]\nList a directory.')
    expect(run.stdout).toMatch(/--path <string>\s+required {2}Absolute remote path/)
    expect(run.stdout).toMatch(/--limit <integer>/)
    expect(run.stdout).toMatch(/--kind <all\|files\|directories>/)
    expect(run.stdout).toMatch(/^ {2}--recursive$/m)
    expect(run.stdout).toMatch(/--names <string> \(repeatable\)/)
  })
})

describe('ftpb tool arguments', () => {
  it('builds the same arguments from --args JSON and from typed flags, in kebab or snake case', async () => {
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

    const viaArgs = await ftpb(['list-directory', '--args', JSON.stringify(expected)])
    const viaFlags = await ftpb([
      'list-directory',
      ...['--path', '/photos', '--limit', '5', '--recursive', '--names', 'a.jpg'],
      ...['--names=b c.jpg', '--sizes', '[1,2.5]', '--filter', '{"minSize":10}']
    ])
    const viaSnake = await ftpb(['list_directory', '--args', '{"path":"/x"}', '--path', '/photos'])
    await ftpb(['delete', '--paths', '/a', '--no-recursive'])
    await ftpb(['delete', '--paths', '/a', '--recursive', 'false'])
    await ftpb(['list-directory', '--path', '/', '--names', '[2024] trip.jpg'])

    expect([viaArgs.code, viaFlags.code, viaSnake.code]).toEqual([0, 0, 0])
    expect(server.calls.map((c) => c.args)).toEqual([
      expected,
      expected,
      { path: '/photos' },
      { paths: ['/a'], recursive: false },
      { paths: ['/a'], recursive: false },
      { path: '/', names: ['[2024] trip.jpg'] }
    ])
    expect(JSON.parse(viaFlags.stdout)).toEqual({ received: expected })
  })

  it('sends a saved server name as a string and an id as a number to connect', async () => {
    // covers: Test-690
    server.calls.length = 0

    const byName = await ftpb(['connect', '--server', 'Pixel phone'])
    const byId = await ftpb(['connect', '--server', '1', '--path', '/DCIM'])
    const byHost = await ftpb(['connect', '--server=192.168.0.7'])
    const help = await ftpb(['connect', '--help'])

    expect([byName.code, byId.code, byHost.code]).toEqual([EXIT.OK, EXIT.OK, EXIT.OK])
    expect(server.calls.map((c) => c.args)).toEqual([
      { server: 'Pixel phone' },
      { server: 1, path: '/DCIM' },
      { server: '192.168.0.7' }
    ])
    expect(help.stdout).toMatch(/--server <integer\|string>\s+required/)
  })

  it('names the accepted forms and --args - in a conversion error, and sends nothing', async () => {
    // covers: Test-692
    server.calls.length = 0

    const run = await ftpb(['list-directory', '--path', '/', '--limit', 'many'])

    expect(run.code).toBe(EXIT.USAGE)
    expect(errorOf(run).message).toMatch(/^--limit needs an integer, got "many"\./)
    expect(errorOf(run).message).toContain('--args -')
    expect(server.calls).toEqual([])
  })

  it('reads the arguments from stdin with --args -, flags after it override', async () => {
    // covers: Test-637
    const name = `a "b" & c | d %PATH% ^e !f\n'g'.jpg`
    const args = { path: '/photos', names: [name], limit: 5 }
    server.calls.length = 0

    const plain = await ftpb(['list-directory', '--args', '-'], { stdin: JSON.stringify(args) })
    const inline = await ftpb(['list_directory', '--args=-', '--limit', '7'], {
      stdin: `\uFEFF${JSON.stringify(args, null, 2)}\n`
    })

    expect([plain.code, inline.code]).toEqual([EXIT.OK, EXIT.OK])
    expect(server.calls.map((c) => c.args)).toEqual([args, { ...args, limit: 7 }])
  })

  it('exits 2 when stdin holds no JSON object, without echoing it or waiting on a terminal', async () => {
    // covers: Test-638
    server.calls.length = 0
    const argv = ['list-directory', '--args', '-']

    const runs = [
      await ftpb(argv, { stdin: 'remote name & more' }),
      await ftpb(argv, { stdin: '["/a"]' }),
      await ftpb(argv, { stdin: '' })
    ]
    const tty = await ftpb(argv, { stdin: Object.assign(new PassThrough(), { isTTY: true }) })

    for (const run of runs) {
      expect(run.code).toBe(EXIT.USAGE)
      expect(errorOf(run).message).toContain('--args - needs a JSON object on stdin')
    }
    expect(runs[0].stderr).not.toContain('remote name')
    expect(tty.code).toBe(EXIT.USAGE)
    expect(errorOf(tty).message).toContain('stdin is a terminal')
    expect(server.calls).toEqual([])
  })
})

describe('ftpb exit codes and output', () => {
  it('maps success, tool errors, usage errors and an unreachable app to 0, 1, 2 and 4', async () => {
    // covers: Test-553
    const wrongToken = { FTPB_URL: server.url, FTPB_TOKEN: 'wrong' }
    const dead = { FTPB_URL: await deadUrl(), FTPB_TOKEN: server.token }
    const cases: Array<[string[], NodeJS.ProcessEnv | undefined, number]> = [
      [['get-status'], undefined, EXIT.OK],
      [['delete', '--paths', '/fail'], undefined, EXIT.TOOL_ERROR],
      [['delete', '--paths', '/busy'], undefined, EXIT.TOOL_ERROR],
      [['list-directory', '--bogus', '1'], undefined, EXIT.USAGE],
      [['list-directory', '--path'], undefined, EXIT.USAGE],
      [['no-such-tool'], undefined, EXIT.USAGE],
      [['--bogus'], undefined, EXIT.USAGE],
      // the input schema rejects it: a usage error too
      [['wait-for-jobs', '--ids', 'j1', '--timeout-sec', '90'], undefined, EXIT.USAGE],
      [['get-status'], wrongToken, EXIT.UNAVAILABLE],
      [['get-status'], dead, EXIT.UNAVAILABLE]
    ]

    for (const [argv, env, code] of cases) {
      const run = await ftpb(argv, { env })
      expect(run.code, argv.join(' ')).toBe(code)
    }
    expect(errorOf(await ftpb(['delete', '--paths', '/busy'])).code).toBe('BUSY')
    const schema = await ftpb(['wait-for-jobs', '--ids', 'j1', '--timeout-sec', '90'])
    expect(errorOf(schema)).toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(errorOf(schema).message).toMatch(/timeoutSec/)
  })

  it('writes the result as compact JSON on stdout and errors as JSON on stderr only', async () => {
    // covers: Test-554
    const ok = await ftpb(['get-status'])
    const failed = await ftpb(['delete', '--paths', '/fail'])
    const usage = await ftpb(['list-directory', '--bogus', '1'])

    expect(ok.stdout).toBe('{"connection":{"status":"connected","host":"nas.local"}}\n')
    expect(failed.stdout).toBe('')
    expect(JSON.parse(failed.stderr)).toEqual({
      error: {
        code: 'FTP_PERMISSION_DENIED',
        message: 'FTP_PERMISSION_DENIED: 550 Permission denied.'
      }
    })
    expect(usage.stdout).toBe('')
    expect(errorOf(usage).message).toMatch(/^Unknown parameter --bogus\. Parameters: --path, /)
  })

  it('documents usage, risk, untrusted names, output, exit codes and one example in --help', async () => {
    // covers: Test-639
    const help = (await ftpb(['--help'])).stdout
    const toolHelp = (await ftpb(['list-directory', '--help'])).stdout
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8')
    const agents = section(readme, /^## 에이전트 연동/m, /^## /m)

    expect(help).toContain('Agent access')
    expect(help).toContain('ftpb tools')
    expect(help).toContain('ftpb <tool> --args -')
    for (const risk of [
      'read-only',
      'changes state, no data loss',
      'uploads local files',
      'DESTRUCTIVE'
    ])
      expect(help).toContain(risk)
    for (const text of [help, agents]) {
      expect(text).toContain('--args -')
      expect(text).toMatch(/untrusted|신뢰할 수 없는/)
      expect(text).toContain('Windows')
    }
    expect(toolHelp).toContain('--args -')
    const exits = section(help, /^Exit codes:/m, /^\S/m)
    for (const code of [0, 1, 2, 4]) expect(exits).toMatch(new RegExp(`^ {2}${code} {2}`, 'm'))
    expect(exits).not.toMatch(/^ {2}3 {2}/m)
  })

  it('walks through list-servers, connect by name, list, download from stdin and wait in --help', async () => {
    // covers: Test-697
    const example = section((await ftpb(['--help'])).stdout, /^Example/m, /^\S/m)

    const steps = [
      'ftpb list-servers',
      'ftpb connect --server "Pixel phone"',
      'ftpb list-directory',
      '--modified-from 2026-09-12 --modified-to 2026-09-12',
      'ftpb download --args -',
      'ftpb wait-for-jobs --ids'
    ].map((step) => example.indexOf(step))
    expect(steps.every((at) => at >= 0)).toBe(true)
    expect([...steps].sort((a, b) => a - b)).toEqual(steps)
    // a long command goes on with a shell line continuation, as the user would type it
    expect(example).toMatch(/ \\\n\s+--modified-from /)
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
      await ftpb(['get-status'], { env: {} }),
      await ftpb(['tools'], { env: {} }),
      await ftpb(['list-directory', '--path', '/'], { env: {} })
    ]

    for (const run of runs) {
      expect(run).toMatchObject({ code: EXIT.UNAVAILABLE, stdout: '' })
      expect(errorOf(run).message).toMatch(
        /^Stale discovery file.*Start FTP Browser and turn on Agent access/
      )
    }
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
    expect(errorOf(tokenOnly).message).toContain('Stale discovery file')
    expect(hits).toBe(0)
  })
})

describe('ftpb image previews', () => {
  it('saves each preview as a JPEG named after its path, adds savedTo and prints no base64', async () => {
    // covers: Test-693
    const tmp = mkdtempSync(join(home, 'tmp-693-'))
    const dir = join(tmp, 'ftpb-previews')
    const paths = ['/DCIM/IMG_0912.jpg', '/DCIM/notes.txt', '/shots/Screen shot.png']
    server.calls.length = 0

    const run = await ftpb(['get-image-previews', ...paths.flatMap((p) => ['--paths', p])], {
      tmpdir: tmp
    })

    expect(run).toMatchObject({ code: EXIT.OK, stderr: '' })
    expect(JSON.parse(run.stdout)).toEqual({
      previews: [
        { path: paths[0], ok: true, savedTo: join(dir, 'IMG_0912.jpg') },
        { path: paths[1], ok: false, error: 'Not an image file.' },
        { path: paths[2], ok: true, savedTo: join(dir, 'Screen shot.jpg') }
      ]
    })
    expect(readFileSync(join(dir, 'IMG_0912.jpg'))).toEqual(previewBytes(paths[0]))
    expect(readFileSync(join(dir, 'Screen shot.jpg'))).toEqual(previewBytes(paths[2]))
    expect(run.stdout).not.toContain(previewBytes(paths[0]).toString('base64'))
    expect(server.calls.map((c) => c.args)).toEqual([{ paths }])
  })

  it('uses index names without a mapping, keeps hostile names inside the folder and never overwrites', async () => {
    // covers: Test-694
    const tmp = mkdtempSync(join(home, 'tmp-694-'))
    const dir = join(tmp, 'ftpb-previews')
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(join(dir, 'IMG_1.jpg'), 'the user file')
    const paths = [
      '/a/IMG_1.jpg',
      '/b/IMG_1.JPG',
      '/x/..\\..\\evil\u0007.jpg',
      '/x/CON.jpg',
      '/x/a​b.jpg',
      '/x/.jpg'
    ]

    const mapped = await ftpb(['get-image-previews', '--args', '-'], {
      stdin: JSON.stringify({ paths }),
      tmpdir: tmp
    })
    const unmapped = await ftpb(
      ['get-image-previews', '--paths', '/a/IMG_1.jpg', '--paths', '/b/c.jpg', '--no-mapped'],
      { tmpdir: tmp }
    )

    expect([mapped.code, unmapped.code]).toEqual([EXIT.OK, EXIT.OK])
    const savedTo = (JSON.parse(mapped.stdout) as { previews: Array<{ savedTo: string }> }).previews
    expect(savedTo.map((p) => p.savedTo)).toEqual(
      ['IMG_1-2.jpg', 'IMG_1-3.jpg', '_.._evil_.jpg', '_CON.jpg', 'a_b.jpg', 'image-6.jpg'].map(
        (name) => join(dir, name)
      )
    )
    expect(JSON.parse(unmapped.stdout)).toEqual({
      savedTo: [join(dir, 'image-1.jpg'), join(dir, 'image-2.jpg')]
    })
    expect(readFileSync(join(dir, 'IMG_1.jpg'), 'utf8')).toBe('the user file')
    expect(readFileSync(join(dir, 'IMG_1-2.jpg'))).toEqual(previewBytes(paths[0]))
    expect(readdirSync(tmp)).toEqual(['ftpb-previews'])
    expect(readdirSync(dir)).toHaveLength(9)
  })

  it('creates <tmpdir>/ftpb-previews owner-only and refuses a symlink or another user’s folder', async () => {
    // covers: Test-695
    const tmp = mkdtempSync(join(home, 'tmp-695-'))

    const run = await ftpb(['get-image-previews', '--paths', '/DCIM/a.jpg'], { tmpdir: tmp })

    expect(run.code).toBe(EXIT.OK)
    if (process.platform === 'win32') return
    expect(statSync(join(tmp, 'ftpb-previews')).mode & 0o777).toBe(0o700)

    const linked = mkdtempSync(join(home, 'tmp-695-link-'))
    const elsewhere = join(linked, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(linked, 'ftpb-previews'))
    const viaLink = await ftpb(['get-image-previews', '--paths', '/DCIM/a.jpg'], { tmpdir: linked })
    const uid = vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1)
    const theirs = await ftpb(['get-image-previews', '--paths', '/DCIM/a.jpg'], { tmpdir: tmp })
    uid.mockRestore()

    for (const refused of [viaLink, theirs]) {
      expect(refused).toMatchObject({ code: EXIT.TOOL_ERROR, stdout: '' })
      expect(errorOf(refused).message).toContain('is not a folder of this user')
    }
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it('prints each piece of data once and documents the output in --help and the README', async () => {
    // covers: Test-696
    const run = await ftpb(['get-image-previews', '--paths', '/DCIM/a.jpg'], {
      tmpdir: mkdtempSync(join(home, 'tmp-696-'))
    })
    const help = (await ftpb(['--help'])).stdout
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8')
    const agents = section(readme, /^## 에이전트 연동/m, /^## /m)

    // structuredContent only: the app's JSON text copy and the base64 image are not printed
    expect(run.stdout.split('"previews"')).toHaveLength(2)
    expect(Object.keys(JSON.parse(run.stdout))).toEqual(['previews'])
    const output = section(help, /^Output/m, /^$/m)
    expect(output).toContain('JSON')
    expect(output).toContain('ftpb-previews')
    expect(output).toContain('savedTo')
    expect(agents).toContain('ftpb-previews')
  })
})
