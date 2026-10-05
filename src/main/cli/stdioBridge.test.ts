import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PassThrough } from 'stream'
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

function startBridge(endpoint: () => { url: string; token: string } | null): Bridge {
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
    fetch: globalThis.fetch,
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
})
