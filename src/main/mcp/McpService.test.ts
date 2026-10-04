import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import net, { type AddressInfo } from 'net'
import Database from 'better-sqlite3'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { McpService, buildClaudeCodeCommand } from './McpService'
import { createMcpToolServer } from './mcpTools'

/** 상수 포트(47821)를 쓰지 않도록 비어 있는 포트를 고른다. */
async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

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

const toolServer = vi.fn(() =>
  createMcpToolServer({
    version: '0.0.0-test',
    ftp: {
      getStatus: () => 'disconnected',
      isConnected: () => false,
      getHost: () => '',
      getPort: () => 0,
      getUser: () => '',
      list: async () => ({ path: '/', entries: [] })
    },
    transfers: { getAll: () => [] },
    previews: async () => []
  })
)

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
let port: number
let service: McpService

beforeEach(async () => {
  toolServer.mockClear()
  db = memoryDb()
  port = await freePort()
  service = new McpService(db, toolServer, port)
})

afterEach(async () => {
  await service.stop()
  db.close()
})

describe('McpService HTTP boundary', () => {
  it('answers 401 without an Authorization header and never runs a tool', async () => {
    // covers: Test-231
    await service.setEnabled(true)

    expect(await postToolCall(port, {})).toBe(401)
    expect(toolServer).not.toHaveBeenCalled()
  })

  it('answers 401 for a wrong token', async () => {
    // covers: Test-232
    await service.setEnabled(true)

    expect(await postToolCall(port, { Authorization: 'Bearer not-the-token' })).toBe(401)
    expect(toolServer).not.toHaveBeenCalled()
  })

  it('answers 403 when the Host header is not localhost', async () => {
    // covers: Test-233
    await service.setEnabled(true)
    const auth = { Authorization: `Bearer ${tokenIn(db)}` }

    expect(await postToolCall(port, { ...auth, Host: `evil.example:${port}` })).toBe(403)
    expect(toolServer).not.toHaveBeenCalled()
  })

  it('answers 403 when the Origin is a foreign site', async () => {
    // covers: Test-234
    await service.setEnabled(true)
    const auth = { Authorization: `Bearer ${tokenIn(db)}` }

    expect(await postToolCall(port, { ...auth, Origin: 'https://evil.example' })).toBe(403)
    expect(toolServer).not.toHaveBeenCalled()
  })

  it('lets an SDK client with the token list exactly the four read-only tools', async () => {
    // covers: Test-235
    const state = await service.setEnabled(true)
    const client = await connectClient(state.url, tokenIn(db)!)

    const { tools } = await client.listTools()
    await client.close()

    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_image_previews',
      'get_status',
      'list_directory',
      'list_transfers'
    ])
    for (const tool of tools) {
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
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve))
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

    for (const scheme of ['Bearer', 'bearer', 'BEARER', 'bEaReR']) {
      expect(await postToolCall(port, { Authorization: `${scheme} ${token}` }), scheme).toBe(200)
      expect(await postToolCall(port, { Authorization: `${scheme} x${token.slice(1)}` })).toBe(401)
    }
    expect(await postToolCall(port, { Authorization: `Basic ${token}` })).toBe(401)
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
    await expect(postToolCall(port, {})).rejects.toMatchObject({ code: 'ECONNREFUSED' })
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
      await expect(postToolCall(port, {})).rejects.toMatchObject({ code: 'ECONNREFUSED' })
      await client.close()
    }
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

    service = new McpService(db, toolServer, port)
    await service.init()

    expect(service.getState()).toMatchObject({ enabled: true, running: true })
    expect(service.getState().command).toContain(token)
    const client = await connectClient(service.getState().url, token!)
    expect((await client.listTools()).tools).toHaveLength(4)
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
    expect(await postToolCall(port, { Authorization: `Bearer ${oldToken}` })).toBe(401)
    const client = await connectClient(state.url, newToken)
    expect((await client.listTools()).tools).toHaveLength(4)
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
