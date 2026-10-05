import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PassThrough } from 'stream'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { makeDeps } from '../mcp/__fixtures__/agentToolHarness'
import { createMcpToolServer } from '../mcp/mcpTools'
import { runStdioBridge } from './stdioBridge'
import { deadUrl, startFakeAgentServer, type FakeAgentServer } from './__fixtures__/fakeAgentServer'

let server: FakeAgentServer

beforeAll(async () => {
  server = await startFakeAgentServer()
})

afterAll(async () => {
  await server.stop()
})

interface Bridge {
  send(message: unknown): void
  raw(line: string): void
  /** Closes stdin, waits for the bridge to end and returns the stdout lines. */
  finish(): Promise<string[]>
  stderr(): string
}

function startBridge(
  endpoint: () => { url: string; token: string } | null,
  fetchImpl: typeof fetch = globalThis.fetch
): Bridge {
  const stdin = new PassThrough()
  let out = ''
  let err = ''
  const done = runStdioBridge({
    stdin,
    stdout: {
      write: (chunk: string) => {
        out += chunk
        return true
      }
    },
    stderr: {
      write: (chunk: string) => {
        err += chunk
        return true
      }
    },
    fetch: fetchImpl,
    endpoint
  })
  return {
    send: (message) => stdin.write(`${JSON.stringify(message)}\n`),
    raw: (line) => stdin.write(line),
    finish: async () => {
      stdin.end()
      await done
      expect(out.endsWith('\n') || out === '').toBe(true)
      return out.split('\n').filter((line) => line !== '')
    },
    stderr: () => err
  }
}

const INIT = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'claude-desktop', version: '1' }
  }
}

describe('ftpb mcp-stdio', () => {
  it('relays stdin JSON-RPC to the app and writes each answer as one stdout line', async () => {
    // covers: Test-556
    const bridge = startBridge(() => ({ url: server.url, token: server.token }))

    bridge.send(INIT)
    bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    bridge.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'wait_for_jobs',
        arguments: { ids: ['j1'], timeoutSec: 5 },
        _meta: { progressToken: 'p' }
      }
    })
    const lines = await bridge.finish()

    // stdout carries protocol messages only: every line is JSON-RPC 2.0.
    const messages = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    for (const message of messages) expect(message.jsonrpc).toBe('2.0')
    const byId = new Map(messages.filter((m) => 'id' in m).map((m) => [m.id, m]))
    expect(byId.get(0)).toMatchObject({ result: { serverInfo: { name: 'ftp-browser' } } })
    const tools = (byId.get(1) as { result: { tools: Array<{ name: string }> } }).result.tools
    expect(tools.map((t) => t.name)).toContain('delete')
    expect(byId.get(2)).toMatchObject({ result: { content: [{ text: '{"done":true}' }] } })
    // Progress notifications from the SSE answer are relayed before the response.
    const progress = messages.filter((m) => m.method === 'notifications/progress')
    expect(progress.map((m) => (m.params as { progress: number }).progress)).toEqual([1, 2])
    expect(messages.indexOf(progress[1])).toBeLessThan(messages.indexOf(byId.get(2)!))
    expect(messages).toHaveLength(5)
  })

  it('answers requests with a JSON-RPC error when the app is not reachable', async () => {
    // covers: Test-556
    const dead = await deadUrl()
    const offline = startBridge(() => null)
    offline.send(INIT)
    offline.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const unreachable = startBridge(() => ({ url: dead, token: 't' }))
    unreachable.send({ jsonrpc: '2.0', id: 'a', method: 'tools/list' })
    const rejected = startBridge(() => ({ url: server.url, token: 'wrong' }))
    rejected.send({ jsonrpc: '2.0', id: 7, method: 'tools/list' })

    const [offlineLines, unreachableLines, rejectedLines] = await Promise.all([
      offline.finish(),
      unreachable.finish(),
      rejected.finish()
    ])

    expect(offlineLines.map((l) => JSON.parse(l))).toEqual([
      {
        jsonrpc: '2.0',
        id: 0,
        error: { code: -32000, message: expect.stringContaining('Start FTP Browser') }
      }
    ])
    expect(JSON.parse(unreachableLines[0])).toMatchObject({ id: 'a', error: { code: -32000 } })
    expect(JSON.parse(rejectedLines[0])).toMatchObject({
      id: 7,
      error: { code: -32000, message: expect.stringContaining('token') }
    })
    expect(offline.stderr()).toContain('Start FTP Browser')
  })

  it('answers a line that is not JSON with a parse error and keeps going', async () => {
    // covers: Test-556
    const bridge = startBridge(() => ({ url: server.url, token: server.token }))

    bridge.raw('{oops\n\n')
    bridge.send({ jsonrpc: '2.0', id: 3, method: 'ping' })
    const lines = await bridge.finish()

    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: expect.any(String) } },
      { jsonrpc: '2.0', id: 3, result: {} }
    ])
  })

  it('drops a null line and other messages that are not objects instead of crashing', async () => {
    // covers: Test-635
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    const posted: unknown[] = []
    const bridge = startBridge(
      () => ({ url: server.url, token: server.token }),
      async (input, init) => {
        posted.push(JSON.parse(String(init?.body)))
        return globalThis.fetch(input, init)
      }
    )
    try {
      const bad = ['null', '42', '"tools/list"', 'true', '[]', '[null]']
      for (const line of bad) bridge.raw(`${line}\n`)
      bridge.raw('[1,{"jsonrpc":"2.0","id":9,"method":"ping"}]\n')
      bridge.send({ jsonrpc: '2.0', id: 3, method: 'ping' })
      const lines = await bridge.finish()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(lines.map((l) => JSON.parse(l))).toEqual([{ jsonrpc: '2.0', id: 3, result: {} }])
      expect(posted).toEqual([{ jsonrpc: '2.0', id: 3, method: 'ping' }])
      expect(
        bridge.stderr().match(/dropped a message that is not a JSON-RPC object/g)
      ).toHaveLength(bad.length + 1)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('drops a line over 4 MiB, whole or in pieces, and keeps relaying', async () => {
    // covers: Test-636
    const bridge = startBridge(() => ({ url: server.url, token: server.token }))
    const huge = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: { pad: 'x'.repeat(4 * 1024 * 1024) }
    })

    // In pieces: the limit is hit long before the newline arrives.
    for (let i = 0; i < huge.length; i += 65536) bridge.raw(huge.slice(i, i + 65536))
    bridge.raw('\n')
    bridge.send({ jsonrpc: '2.0', id: 2, method: 'ping' })
    // Whole, in one write with its newline.
    bridge.raw(`${huge.replace('"id":1', '"id":4')}\n`)
    bridge.send({ jsonrpc: '2.0', id: 5, method: 'ping' })
    const lines = await bridge.finish()

    const tooLarge = {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: expect.stringContaining('too large') }
    }
    const messages = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(messages.filter((m) => m.id === null)).toEqual([tooLarge, tooLarge])
    expect(messages.filter((m) => m.id !== null)).toEqual([
      { jsonrpc: '2.0', id: 2, result: {} },
      { jsonrpc: '2.0', id: 5, result: {} }
    ])
    expect(bridge.stderr().match(/longer than 4194304 characters/g)).toHaveLength(2)
  })

  it('writes only JSON-RPC 2.0 messages of the answer to stdout', async () => {
    // covers: Test-636
    const json = (body: string): Response =>
      new Response(body, { headers: { 'content-type': 'application/json' } })
    const answers = [json('{}'), json('[{"status":"ok"},{"jsonrpc":"2.0","id":2,"result":{}}]')]
    const bridge = startBridge(
      () => ({ url: 'http://127.0.0.1:1/mcp', token: 't' }),
      async () => answers.shift() ?? json('{}')
    )

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'ping' })
    bridge.send({ jsonrpc: '2.0', id: 2, method: 'ping' })
    const lines = await bridge.finish()

    const messages = lines.map((l) => JSON.parse(l) as { id: number })
    expect(messages.sort((a, b) => a.id - b.id)).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: expect.stringContaining('HTTP 200') }
      },
      { jsonrpc: '2.0', id: 2, result: {} }
    ])
    expect(bridge.stderr()).toContain('not a JSON-RPC 2.0 message')
  })

  it("sends the stdio client's initialize clientInfo as the User-Agent from then on", async () => {
    // covers: Test-664
    const seen: Array<[string, string | null]> = []
    const bridge = startBridge(
      () => ({ url: server.url, token: server.token }),
      async (input, init) => {
        const { method } = JSON.parse(String(init?.body)) as { method: string }
        seen.push([method, new Headers(init?.headers).get('user-agent')])
        return globalThis.fetch(input, init)
      }
    )

    bridge.send({ jsonrpc: '2.0', id: 'early', method: 'ping' })
    bridge.send(INIT)
    bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    bridge.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_status', arguments: {} }
    })
    await bridge.finish()

    const agent = 'claude-desktop/1 (via ftpb mcp-stdio)'
    expect(seen).toEqual([
      ['ping', null],
      ['initialize', agent],
      ['notifications/initialized', agent],
      ['tools/list', agent],
      ['tools/call', agent]
    ])
  })

  it('keeps only printable ASCII in that User-Agent, at most 100 characters, and sets none without a name', async () => {
    // covers: Test-665
    const agentFor = async (clientInfo: unknown): Promise<string | null> => {
      const agents: Array<string | null> = []
      const bridge = startBridge(
        () => ({ url: server.url, token: server.token }),
        async (input, init) => {
          agents.push(new Headers(init?.headers).get('user-agent'))
          return globalThis.fetch(input, init)
        }
      )
      bridge.send({ ...INIT, params: { ...INIT.params, clientInfo } })
      bridge.send({ jsonrpc: '2.0', id: 1, method: 'ping' })
      await bridge.finish()
      expect(agents).toHaveLength(2)
      expect(agents[1]).toBe(agents[0])
      return agents[1]
    }

    const hostile = 'claude\u0000-desk\ttop\r\nX-Evil: 1\u202e\u00e9'
    expect(await agentFor({ name: hostile, version: '1.2\u0007' })).toBe(
      'claude-desktopX-Evil: 1/1.2 (via ftpb mcp-stdio)'
    )
    expect(await agentFor({ name: 'cursor' })).toBe('cursor (via ftpb mcp-stdio)')
    const long = await agentFor({ name: 'a'.repeat(300), version: '9'.repeat(50) })
    expect(long).toHaveLength(100)
    expect(long).toMatch(/^a+ \(via ftpb mcp-stdio\)$/)
    const nameless = [undefined, { version: '1' }, { name: 42 }, { name: '\u65e5\u672c' }]
    for (const clientInfo of nameless) {
      expect(await agentFor(clientInfo), JSON.stringify(clientInfo)).toBeNull()
    }
  })

  it('names a stdio client behind the bridge in the confirmation instead of "node"', async () => {
    // covers: Test-666
    const deps = makeDeps()
    deps.confirm.mockResolvedValue('denied')
    const handler = createMcpHandler(() => createMcpToolServer(deps))
    const bridge = startBridge(
      () => ({ url: 'http://localhost/mcp', token: 't' }),
      async (input, init) => handler.fetch(new Request(input, init))
    )

    bridge.send(INIT)
    bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    bridge.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'delete', arguments: { paths: ['/a.jpg'] } }
    })
    const lines = await bridge.finish()

    expect(JSON.parse(lines[lines.length - 1])).toMatchObject({ id: 1, result: { isError: true } })
    expect(deps.confirm).toHaveBeenCalledTimes(1)
    expect(deps.confirm.mock.calls[0][0].client).toBe('claude-desktop/1 (via ftpb mcp-stdio)')
  })
})
