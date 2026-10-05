import { createInterface } from 'readline'
import { APP_NOT_RUNNING, postJsonRpc, type Endpoint, type JsonRpcMessage } from './mcpClient'

/**
 * `ftpb mcp-stdio`: newline-delimited JSON-RPC on stdin/stdout ⇄ the app's Streamable HTTP endpoint
 * (§2.6 L2, research §6). For stdio-only clients such as Claude Desktop. stdout carries protocol
 * messages only; diagnostics go to stderr. Each message is one POST, sent as it arrives, so a long
 * wait_for_jobs call does not hold back a ping; SSE answers (progress, then the response) are
 * relayed line by line as they arrive.
 */
export interface BridgeOptions {
  stdin: NodeJS.ReadableStream
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  fetch: typeof fetch
  /** Read again for every message: the app may start, or regenerate its token, while we run. */
  endpoint: () => Endpoint | null
}

type Id = string | number

function isRequest(message: JsonRpcMessage): message is JsonRpcMessage & { id: Id } {
  return (
    typeof message.method === 'string' &&
    (typeof message.id === 'string' || typeof message.id === 'number')
  )
}

function isResponse(message: JsonRpcMessage): boolean {
  return 'id' in message && ('result' in message || 'error' in message)
}

export async function runStdioBridge(options: BridgeOptions): Promise<void> {
  const headers: Record<string, string> = {}
  const pending = new Set<Promise<void>>()
  const controllers = new Map<Id, AbortController>()
  const write = (message: JsonRpcMessage): void => {
    options.stdout.write(`${JSON.stringify(message)}\n`)
  }
  const log = (text: string): void => {
    options.stderr.write(`ftpb mcp-stdio: ${text}\n`)
  }

  const relay = async (message: JsonRpcMessage | JsonRpcMessage[]): Promise<void> => {
    const batch = Array.isArray(message) ? message : [message]
    const requests = batch.filter(isRequest)
    const answered = new Set<Id>()
    const failUnanswered = (text: string): void => {
      for (const request of requests) {
        if (!answered.has(request.id)) {
          write({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: text } })
        }
      }
    }

    // Client cancellation: over Streamable HTTP, closing that request's stream cancels it.
    for (const item of batch) {
      if (item.method === 'notifications/cancelled') {
        const requestId = (item.params as { requestId?: Id } | undefined)?.requestId
        if (requestId !== undefined) controllers.get(requestId)?.abort()
      }
    }

    const endpoint = options.endpoint()
    if (!endpoint) {
      log(APP_NOT_RUNNING)
      failUnanswered(APP_NOT_RUNNING)
      return
    }
    const single = !Array.isArray(message) && isRequest(message) ? message : undefined
    const controller = single ? new AbortController() : undefined
    if (single && controller) controllers.set(single.id, controller)
    try {
      const { status, sessionId } = await postJsonRpc(message, {
        fetch: options.fetch,
        endpoint,
        headers,
        signal: controller?.signal,
        onMessage: (answer) => {
          // An error the server could not tie to a request (id: null) answers ours, so the client stops waiting.
          const reply =
            single && answer.id === null && answer.error ? { ...answer, id: single.id } : answer
          if (isResponse(reply)) answered.add(reply.id as Id)
          if (single?.method === 'initialize' && reply.id === single.id) {
            const version = (reply.result as { protocolVersion?: unknown } | undefined)
              ?.protocolVersion
            if (typeof version === 'string') headers['MCP-Protocol-Version'] = version
          }
          write(reply)
        }
      })
      if (sessionId) headers['Mcp-Session-Id'] = sessionId
      failUnanswered(`FTP Browser answered HTTP ${status} without a JSON-RPC response.`)
    } catch (err) {
      if (controller?.signal.aborted) return
      const text = err instanceof Error ? err.message : String(err)
      log(text)
      failUnanswered(text)
    } finally {
      if (single) controllers.delete(single.id)
    }
  }

  const lines = createInterface({ input: options.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() === '') continue
    let message: JsonRpcMessage | JsonRpcMessage[]
    try {
      message = JSON.parse(line) as JsonRpcMessage | JsonRpcMessage[]
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: not JSON' } })
      continue
    }
    const task = relay(message).finally(() => pending.delete(task))
    pending.add(task)
  }
  await Promise.all(pending)
}
