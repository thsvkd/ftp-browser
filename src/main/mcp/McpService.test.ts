import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import net, { type AddressInfo } from 'net'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { McpService, buildClaudeCodeCommand } from './McpService'
import { createMcpToolServer } from './mcpTools'
import { makeDeps } from './__fixtures__/agentToolHarness'

function memoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return db
}

function tokenIn(db: Database.Database): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'mcpToken'").get() as
    | { value: string }
    | undefined
  return row?.value
}

const toolServer = vi.fn(() => createMcpToolServer(makeDeps()))

/** 기본 정책(D·X·C는 ask, deny 없음)에서 tools/list에 나오는 도구 수 */
const TOOL_COUNT = 22

/** SDK가 보내는 것과 같은 tools/call POST. Host·Origin을 직접 정할 수 있게 node:http로 보낸다. */
function postToolCall(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...headers
        }
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }
    )
    req.on('error', reject)
    req.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_status', arguments: {} }
      })
    )
  })
}

async function connectClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  )
  return client
}

let db: Database.Database
let service: McpService

/** 서비스가 연 포트(끈 뒤에는 마지막으로 연 포트) */
function port(): number {
  return Number(new URL(service.getState().url).port)
}

beforeEach(() => {
  toolServer.mockClear()
  db = memoryDb()
  // 포트 0: OS가 고른 포트에 바로 연다. 빈 포트를 골라 닫은 뒤 다시 열면 그 사이에
  // 다른 테스트 worker가 그 포트를 가져갈 수 있다(Test-668).
  service = new McpService(db, toolServer, 0)
})

afterEach(async () => {
  await service.stop()
  db.close()
})

describe('McpService HTTP boundary', () => {
  it('answers 401 without an Authorization header and never runs a tool', async () => {
    // covers: Test-231
    await service.setEnabled(true)

    expect(await postToolCall(port(), {})).toBe(401)
    expect(toolServer).not.toHaveBeenCalled()
  })

  it('answers 401 for a wrong token', async () => {
    // covers: Test-232
    await service.setEnabled(true)

    expect(await postToolCall(port(), { Authorization: 'Bearer not-the-token' })).toBe(401)
    expect(toolServer).not.toHaveBeenCalled()
  })

  it('answers 403 when the Host header is not localhost', async () => {
    // covers: Test-233
    await service.setEnabled(true)
    const auth = { Authorization: `Bearer ${tokenIn(db)}` }

    expect(await postToolCall(port(), { ...auth, Host: `evil.example:${port()}` })).toBe(403)
    expect(toolServer).not.toHaveBeenCalled()
  })

  it('answers 403 when the Origin is a foreign site', async () => {
    // covers: Test-234
    await service.setEnabled(true)
    const auth = { Authorization: `Bearer ${tokenIn(db)}` }

    expect(await postToolCall(port(), { ...auth, Origin: 'https://evil.example' })).toBe(403)
    expect(toolServer).not.toHaveBeenCalled()
  })

  it('lets an SDK client with the token list the tools, read-only ones marked as such', async () => {
    // covers: Test-235
    const state = await service.setEnabled(true)
    const client = await connectClient(state.url, tokenIn(db)!)

    const { tools } = await client.listTools()
    await client.close()

    expect(tools).toHaveLength(TOOL_COUNT)
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['get_image_previews', 'get_status', 'list_directory', 'list_jobs'])
    )
    for (const tool of tools.filter((t) => t.description?.startsWith('[RISK R:'))) {
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false
      })
    }
  })

  it('binds only to 127.0.0.1', async () => {
    // covers: Test-236
    await service.setEnabled(true)

    expect(service.address()?.address).toBe('127.0.0.1')
  })

  it('reports a port already in use in the state instead of throwing', async () => {
    // covers: Test-237
    const blocker = net.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    service = new McpService(db, toolServer, (blocker.address() as AddressInfo).port)
    try {
      const state = await service.setEnabled(true)

      expect(state).toMatchObject({ enabled: true, running: false })
      expect(state.error).toMatch(/EADDRINUSE/)
    } finally {
      await new Promise((resolve) => blocker.close(resolve))
    }
  })

  it('accepts the Bearer scheme in any letter case but still checks the token', async () => {
    // covers: Test-295
    await service.setEnabled(true)
    const token = tokenIn(db)!
    // 첫 글자만 다른 토큰. `x${token.slice(1)}`은 토큰이 x로 시작하면(1/64) 진짜 토큰이라 200을 받았다.
    const wrong = `${token.startsWith('x') ? 'y' : 'x'}${token.slice(1)}`

    for (const scheme of ['Bearer', 'bearer', 'BEARER', 'bEaReR']) {
      expect(await postToolCall(port(), { Authorization: `${scheme} ${token}` }), scheme).toBe(200)
      expect(await postToolCall(port(), { Authorization: `${scheme} ${wrong}` })).toBe(401)
    }
    expect(await postToolCall(port(), { Authorization: `Basic ${token}` })).toBe(401)
  })

  it('shares one in-flight listen between overlapping enable and disable calls', async () => {
    // covers: Test-296
    const both = await Promise.all([service.setEnabled(true), service.setEnabled(true)])
    for (const state of both) {
      expect(state).toMatchObject({ enabled: true, running: true })
      expect(state.error).toBeUndefined()
    }
    await service.setEnabled(false)

    // 같은 틱의 켜기→끄기: 끄기가 진행 중인 listen을 기다려 닫아야 서버가 뒤늦게 열려 남지 않는다.
    const on = service.setEnabled(true)
    const off = service.setEnabled(false)
    await Promise.all([on, off])

    expect(service.getState()).toMatchObject({ enabled: false, running: false })
    await expect(postToolCall(port(), {})).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('refuses connections after stop and listens again on every restart', async () => {
    // covers: Test-238
    for (let round = 0; round < 3; round++) {
      const state = await service.setEnabled(true)
      expect(state.running).toBe(true)
      // keep-alive 연결이 남아 있어도 끄기가 끝나야 한다.
      const client = await connectClient(state.url, tokenIn(db)!)
      await client.listTools()

      expect((await service.setEnabled(false)).running).toBe(false)
      await expect(postToolCall(port(), {})).rejects.toMatchObject({ code: 'ECONNREFUSED' })
      await client.close()
    }
  })

  it('reports the port the OS picked for port 0 and listens on it again after a restart', async () => {
    // covers: Test-668
    expect(service.getState().url).toBe('http://127.0.0.1:0/mcp')

    const state = await service.setEnabled(true)
    const bound = service.address()!.port

    expect(bound).toBeGreaterThan(0)
    expect(state.url).toBe(`http://127.0.0.1:${bound}/mcp`)
    expect(state.command).toContain(state.url)
    await service.setEnabled(false)
    expect(service.getState().url).toBe(state.url)
    expect((await service.setEnabled(true)).url).toBe(state.url)
    expect(service.address()?.port).toBe(bound)
  })
})

describe('McpService settings', () => {
  it('starts off, creates and stores a token when enabled, and reuses it after a restart', async () => {
    // covers: Test-249
    expect(service.getState()).toMatchObject({ enabled: false, running: false })
    expect(service.getState().command).toBeUndefined()

    await service.setEnabled(true)
    const token = tokenIn(db)
    expect(token).toMatch(/^[\w-]{43}$/)
    expect(service.getState().command).toContain(token)
    await service.stop()

    service = new McpService(db, toolServer, 0)
    await service.init()

    expect(service.getState()).toMatchObject({ enabled: true, running: true })
    expect(service.getState().command).toContain(token)
    const client = await connectClient(service.getState().url, token!)
    expect((await client.listTools()).tools).toHaveLength(TOOL_COUNT)
    await client.close()
  })

  it('rejects the old token and accepts the new one after regeneration', async () => {
    // covers: Test-250
    await service.setEnabled(true)
    const oldToken = tokenIn(db)!

    const state = service.regenerateToken()
    const newToken = tokenIn(db)!

    expect(newToken).not.toBe(oldToken)
    expect(state.command).toContain(newToken)
    expect(await postToolCall(port(), { Authorization: `Bearer ${oldToken}` })).toBe(401)
    const client = await connectClient(state.url, newToken)
    expect((await client.listTools()).tools).toHaveLength(TOOL_COUNT)
    await client.close()
  })

  it('builds the Claude Code registration command from the URL and token', () => {
    // covers: Test-251
    expect(buildClaudeCodeCommand('http://127.0.0.1:47821/mcp', 'abc-123_XYZ')).toBe(
      'claude mcp add --scope user --transport http ftp-browser http://127.0.0.1:47821/mcp ' +
        '--header "Authorization: Bearer abc-123_XYZ"'
    )
  })
})

describe('McpService discovery file', () => {
  it('writes the endpoint and token files 0600 while listening and removes them on stop', async () => {
    // covers: Test-465
    const userData = mkdtempSync(join(tmpdir(), 'ftpb-discovery-'))
    try {
      await service.stop()
      service = new McpService(db, toolServer, 0, { userDataDir: userData, version: '9.8.7' })
      const endpoint = join(userData, 'agent', 'endpoint.json')
      const tokenFile = join(userData, 'agent', 'token')

      const state = await service.setEnabled(true)

      expect(JSON.parse(readFileSync(endpoint, 'utf8'))).toEqual({
        url: state.url,
        pid: process.pid,
        version: '9.8.7'
      })
      expect(readFileSync(tokenFile, 'utf8').trim()).toBe(tokenIn(db))
      if (process.platform !== 'win32') {
        expect(statSync(endpoint).mode & 0o777).toBe(0o600)
        expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
      }

      // 토큰을 바꾸면 CLI가 읽는 파일도 바로 바뀐다.
      service.regenerateToken()
      expect(readFileSync(tokenFile, 'utf8').trim()).toBe(tokenIn(db))

      await service.setEnabled(false)

      expect(existsSync(endpoint)).toBe(false)
      expect(existsSync(tokenFile)).toBe(false)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
