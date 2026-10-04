import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { randomBytes, timingSafeEqual } from 'crypto'
import type Database from 'better-sqlite3'
import { createMcpHandler, type McpHttpHandler, type McpServer } from '@modelcontextprotocol/server'
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler
} from '@modelcontextprotocol/node'
import { MCP_PORT } from '@shared/constants'
import type { McpState } from '@shared/types/mcp'

/** Claude Code에 이 앱을 user 스코프 HTTP MCP 서버로 등록하는 명령 */
export function buildClaudeCodeCommand(url: string, token: string): string {
  return `claude mcp add --scope user --transport http ftp-browser ${url} --header "Authorization: Bearer ${token}"`
}

const validateHost = localhostHostValidation()
const validateOrigin = localhostOriginValidation()

/**
 * 내장 MCP 서버(Streamable HTTP)의 켜기·끄기·토큰. 설정은 SQLite `settings`의
 * `mcpEnabled`('true'/'false')와 `mcpToken`에 둔다. 127.0.0.1에만 바인드하고
 * Host·Origin 검증(403) 뒤 Bearer 토큰(401)을 확인한 요청만 `/mcp` 핸들러로 넘긴다.
 */
export class McpService {
  private server: Server | null = null
  private handler: McpHttpHandler | null = null
  private error: string | undefined
  private token: string | undefined

  constructor(
    private db: Database.Database,
    private createToolServer: () => McpServer,
    private port = MCP_PORT
  ) {
    this.token = this.readSetting('mcpToken')
  }

  /** 앱 시작 시 저장된 설정이 켜져 있으면 연다. listen 실패는 state.error로만 남는다. */
  async init(): Promise<void> {
    if (this.readSetting('mcpEnabled') === 'true') await this.listen()
  }

  getState(): McpState {
    const url = `http://127.0.0.1:${this.port}/mcp`
    return {
      enabled: this.readSetting('mcpEnabled') === 'true',
      running: this.server !== null,
      url,
      ...(this.token ? { command: buildClaudeCodeCommand(url, this.token) } : {}),
      ...(this.error ? { error: this.error } : {})
    }
  }

  async setEnabled(enabled: boolean): Promise<McpState> {
    this.writeSetting('mcpEnabled', enabled ? 'true' : 'false')
    if (enabled) {
      await this.listen()
    } else {
      this.error = undefined
      await this.stop()
    }
    return this.getState()
  }

  /** 새 토큰은 즉시 적용된다. 이전 토큰으로 등록한 클라이언트는 다음 요청부터 401을 받는다. */
  regenerateToken(): McpState {
    this.saveNewToken()
    return this.getState()
  }

  /** 설정은 바꾸지 않고 서버만 닫는다(앱 종료). */
  async stop(): Promise<void> {
    const { server, handler } = this
    if (!server || !handler) return
    this.server = null
    this.handler = null
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeAllConnections()
    await Promise.all([closed, handler.close()])
  }

  address(): AddressInfo | null {
    return (this.server?.address() as AddressInfo | null | undefined) ?? null
  }

  private async listen(): Promise<void> {
    if (this.server) return
    if (!this.token) this.saveNewToken()
    const handler = createMcpHandler(() => this.createToolServer())
    const nodeHandler = toNodeHandler(handler)
    const server = createServer((req, res) => {
      if (!validateHost(req, res) || !validateOrigin(req, res)) return
      if (!this.isAuthorized(req)) {
        respondError(res, 401, 'Unauthorized: missing or invalid bearer token')
        return
      }
      if ((req.url ?? '').split('?')[0] !== '/mcp') {
        respondError(res, 404, 'Not found')
        return
      }
      void nodeHandler(req, res)
    })
    try {
      // 'error' 리스너를 listen 뒤에도 남겨 둔다. 리스너 없는 'error'는 main 프로세스를 죽인다.
      await new Promise<void>((resolve, rejectListen) => {
        server.on('error', rejectListen)
        server.listen(this.port, '127.0.0.1', resolve)
      })
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
      await handler.close()
      return
    }
    this.server = server
    this.handler = handler
    this.error = undefined
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if (!this.token) return false
    const expected = Buffer.from(`Bearer ${this.token}`)
    const actual = Buffer.from(req.headers.authorization ?? '')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  private saveNewToken(): void {
    this.token = randomBytes(32).toString('base64url')
    this.writeSetting('mcpToken', this.token)
  }

  private readSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  private writeSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }
}

function respondError(res: ServerResponse, status: number, message: string): void {
  res
    .writeHead(status, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }))
}
