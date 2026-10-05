/**
 * The smallest Streamable HTTP JSON-RPC client `ftpb` needs (no SDK: the CLI must stay one
 * dependency-free file, §2.6 L1). One POST per message; the app answers with JSON or with an SSE
 * stream that may carry notifications (progress) before the response.
 */

export type JsonRpcMessage = Record<string, unknown>

export interface Endpoint {
  url: string
  token: string
}

export const APP_NOT_RUNNING =
  'FTP Browser is not running or Agent access is off. Start FTP Browser and turn on Agent access ' +
  'in Settings (Enable MCP server), then retry.'
export const TOKEN_REJECTED =
  'FTP Browser rejected the token (it may have been regenerated). If FTPB_TOKEN is set, update or ' +
  'unset it; otherwise retry.'

/** The app cannot be reached or refused the token: exit 4 for the CLI. */
export class EndpointUnavailableError extends Error {}

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

export interface PostOptions {
  fetch: typeof fetch
  endpoint: Endpoint
  /** Extra headers: MCP-Protocol-Version, Mcp-Session-Id. */
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Every JSON-RPC message of the answer, in order, as it arrives. */
  onMessage: (message: JsonRpcMessage) => void
}

export interface PostResult {
  status: number
  sessionId?: string
}

function emit(value: unknown, onMessage: (message: JsonRpcMessage) => void): void {
  for (const item of Array.isArray(value) ? value : [value]) {
    if (item && typeof item === 'object') onMessage(item as JsonRpcMessage)
  }
}

/** Server-Sent Events → JSON-RPC messages (WHATWG event-stream rules for data/event/comments). */
async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: JsonRpcMessage) => void
): Promise<void> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  let data: string[] = []
  let event = ''
  const dispatch = (): void => {
    const text = data.join('\n')
    if (text.trim() !== '' && (event === '' || event === 'message')) {
      try {
        emit(JSON.parse(text), onMessage)
      } catch {
        // Skip events that are not protocol messages (e.g. empty priming events).
      }
    }
    data = []
    event = ''
  }
  const line = (text: string): void => {
    if (text === '') return dispatch()
    if (text.startsWith(':')) return
    const colon = text.indexOf(':')
    const field = colon < 0 ? text : text.slice(0, colon)
    const value = colon < 0 ? '' : text.slice(colon + 1).replace(/^ /, '')
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
  }
  for (;;) {
    const { done, value } = await reader.read()
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
    // Keep a trailing \r: it may pair with a \n at the start of the next chunk.
    const parts = buffer.split(/\r\n|\n|\r(?!$)/)
    buffer = done ? '' : (parts.pop() ?? '')
    for (const part of parts) line(part)
    if (done) {
      if (buffer !== '') line(buffer)
      if (data.length > 0) dispatch()
      return
    }
  }
}

/** POST one JSON-RPC message (or batch) and hand every message of the answer to `onMessage`. */
export async function postJsonRpc(body: unknown, options: PostOptions): Promise<PostResult> {
  let res: Response
  try {
    res = await options.fetch(options.endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${options.endpoint.token}`,
        ...options.headers
      },
      body: JSON.stringify(body),
      signal: options.signal
    })
  } catch (err) {
    if (options.signal?.aborted) throw err
    throw new EndpointUnavailableError(APP_NOT_RUNNING)
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel()
    throw new EndpointUnavailableError(`${TOKEN_REJECTED} (HTTP ${res.status})`)
  }
  const sessionId = res.headers.get('mcp-session-id') ?? undefined
  const type = res.headers.get('content-type') ?? ''
  if (type.includes('text/event-stream') && res.body) {
    await readEventStream(res.body, options.onMessage)
  } else {
    const text = await res.text()
    if (type.includes('json') && text.trim() !== '') {
      try {
        emit(JSON.parse(text), options.onMessage)
      } catch {
        // Labelled JSON but not JSON: the caller goes by the status code.
      }
    }
  }
  return { status: res.status, ...(sessionId ? { sessionId } : {}) }
}

/**
 * One CLI run's requests. They use protocol revision 2026-07-28: every request carries its own
 * `_meta` envelope (protocol version, clientInfo, capabilities), so there is no initialize round
 * trip, and the app knows each call comes from `ftpb` (its confirmation dialog shows the client).
 */
export const MODERN_PROTOCOL_VERSION = '2026-07-28'

/** Methods whose `Mcp-Name` header mirrors a body field (SEP-2243). */
const NAME_HEADER_SOURCE: Record<string, string> = { 'tools/call': 'name', 'prompts/get': 'name' }

export class McpSession {
  private nextId = 1

  constructor(
    private readonly endpoint: Endpoint,
    private readonly fetchImpl: typeof fetch,
    private readonly clientVersion: string
  ) {}

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++
    const nameField = NAME_HEADER_SOURCE[method]
    const name = nameField ? params[nameField] : undefined
    const envelope = {
      ...(params._meta as Record<string, unknown> | undefined),
      'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo': { name: 'ftpb', version: this.clientVersion },
      'io.modelcontextprotocol/clientCapabilities': {}
    }
    let response: JsonRpcMessage | undefined
    let stray: JsonRpcMessage | undefined
    const { status } = await postJsonRpc(
      { jsonrpc: '2.0', id, method, params: { ...params, _meta: envelope } },
      {
        fetch: this.fetchImpl,
        endpoint: this.endpoint,
        headers: {
          'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
          'Mcp-Method': method,
          ...(typeof name === 'string' ? { 'Mcp-Name': name } : {})
        },
        onMessage: (message) => {
          if (message.id === id) response = message
          else if (message.id === null && message.error) stray = message
        }
      }
    )
    const answer = response ?? stray
    if (!answer) throw new Error(`FTP Browser did not answer ${method} (HTTP ${status}).`)
    if (answer.error) {
      const error = answer.error as { code?: unknown; message?: unknown }
      throw new JsonRpcError(
        typeof error.code === 'number' ? error.code : -32603,
        typeof error.message === 'string' ? error.message : JSON.stringify(error)
      )
    }
    return (answer.result ?? {}) as Record<string, unknown>
  }
}
