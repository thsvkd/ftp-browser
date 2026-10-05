import { StringDecoder } from 'string_decoder'
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
  /**
   * Read again for every message: the app may start, or regenerate its token, while we run. Throws
   * (e.g. a stale discovery file) to fail the message with that error's text.
   */
  endpoint: () => Endpoint | null
}

type Id = string | number

/**
 * Longest line relayed: the app's request body limit (the MCP SDK's 4 MiB). A longer line is
 * dropped as it arrives instead of being buffered whole (§9 R6).
 */
const MAX_LINE = 4 * 1024 * 1024

const isObject = (value: unknown): value is JsonRpcMessage =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A JSON-RPC message or batch: an object, or a non-empty array of objects (§9 R6). */
function isMessage(value: unknown): value is JsonRpcMessage | JsonRpcMessage[] {
  return isObject(value) || (Array.isArray(value) && value.length > 0 && value.every(isObject))
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The newline-delimited lines of `input`; a line over MAX_LINE goes to `onTooLong` instead. */
async function* readLines(
  input: NodeJS.ReadableStream,
  onTooLong: () => void
): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8')
  let partial = ''
  let skipping = false
  for await (const chunk of input) {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let start = 0
    for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n', start)) {
      const line = partial + text.slice(start, end)
      partial = ''
      start = end + 1
      if (skipping) skipping = false
      else if (line.length > MAX_LINE) onTooLong()
      else yield line
    }
    if (skipping) continue
    partial += text.slice(start)
    if (partial.length > MAX_LINE) {
      onTooLong()
      skipping = true
      partial = ''
    }
  }
  if (skipping) return
  const last = partial + decoder.end()
  if (last.length > MAX_LINE) onTooLong()
  else if (last !== '') yield last
}

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

    let endpoint: Endpoint | null = null
    let unavailable = APP_NOT_RUNNING
    try {
      endpoint = options.endpoint()
    } catch (err) {
      unavailable = errorText(err)
    }
    if (!endpoint) {
      log(unavailable)
      failUnanswered(unavailable)
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
          // stdout carries JSON-RPC only; the request then fails below as unanswered.
          if (answer.jsonrpc !== '2.0') {
            log('ignored part of the answer that is not a JSON-RPC 2.0 message')
            return
          }
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
      const text = errorText(err)
      log(text)
      failUnanswered(text)
    } finally {
      if (single) controllers.delete(single.id)
    }
  }

  const tooLong = (): void => {
    log(`dropped a line longer than ${MAX_LINE} characters`)
    const message = `Message too large: lines longer than ${MAX_LINE} characters are dropped.`
    write({ jsonrpc: '2.0', id: null, error: { code: -32600, message } })
  }
  for await (const line of readLines(options.stdin, tooLong)) {
    if (line.trim() === '') continue
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: not JSON' } })
      continue
    }
    if (!isMessage(message)) {
      // e.g. `null`: relaying it crashed the bridge (649c370 review, §9 R6)
      log(
        `dropped a message that is not a JSON-RPC object or a batch of objects: ${line.slice(0, 60)}`
      )
      continue
    }
    const task = relay(message)
      .catch((err: unknown) => log(`could not relay a message: ${errorText(err)}`))
      .finally(() => pending.delete(task))
    pending.add(task)
  }
  await Promise.all(pending)
}
