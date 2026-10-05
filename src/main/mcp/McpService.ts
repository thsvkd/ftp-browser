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
import { removeDiscovery, writeDiscovery } from '../agent/discovery'

/** Claude Code에 이 앱을 user 스코프 HTTP MCP 서버로 등록하는 명령 */
export function buildClaudeCodeCommand(url: string, token: string): string {
  return `claude mcp add --scope user --transport http ftp-browser ${url} --header "Authorization: Bearer ${token}"`
}

const validateHost = localhostHostValidation()
const validateOrigin = localhostOriginValidation()

/** 발견 파일(L4)을 쓸 userData 폴더와 앱 버전. 없으면 쓰지 않는다(테스트). */
export interface DiscoveryOptions {
  userDataDir: string
  version: string
}

/**
 * 내장 MCP 서버(Streamable HTTP)의 켜기·끄기·토큰. 설정은 SQLite `settings`의
 * `mcpEnabled`('true'/'false')와 `mcpToken`에 둔다. 127.0.0.1에만 바인드하고
 * Host·Origin 검증(403) 뒤 Bearer 토큰(401)을 확인한 요청만 `/mcp` 핸들러로 넘긴다.
 */
export class McpService {
  private server: Server | null = null
  private handler: McpHttpHandler | null = null
  /** 진행 중인 listen. 겹친 켜기는 이것을 함께 기다리고, stop()은 이것이 끝난 뒤 닫는다. */
  private listening: Promise<void> | null = null
  private error: string | undefined
  private token: string | undefined

  constructor(
    private db: Database.Database,
    private createToolServer: () => McpServer,
    private port = MCP_PORT,
    private discovery?: DiscoveryOptions
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
    if (this.server) this.publishDiscovery()
    return this.getState()
  }

  /** 설정은 바꾸지 않고 서버만 닫는다(앱 종료). 진행 중인 listen이 있으면 그 결과까지 닫는다. */
  async stop(): Promise<void> {
    if (this.listening) await this.listening
    const { server, handler } = this
    if (!server || !handler) return
    this.server = null
    this.handler = null
    this.withdrawDiscovery()
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeAllConnections()
    await Promise.all([closed, handler.close()])
  }

  address(): AddressInfo | null {
    return (this.server?.address() as AddressInfo | null | undefined) ?? null
  }

  private listen(): Promise<void> {
    if (this.server) return Promise.resolve()
    this.listening ??= this.startListening().finally(() => {
      this.listening = null
    })
    return this.listening
  }

  private async startListening(): Promise<void> {
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
    this.publishDiscovery()
  }

  /** CLI(`ftpb`)가 앱을 찾는 파일을 0600으로 쓴다. 실패해도 MCP 서버는 그대로 둔다(CLI만 못 찾는다). */
  private publishDiscovery(): void {
    if (!this.discovery || !this.token) return
    try {
      writeDiscovery(this.discovery.userDataDir, {
        url: this.getState().url,
        token: this.token,
        pid: process.pid,
        version: this.discovery.version
      })
    } catch (err) {
      console.warn('[mcp] could not write the agent discovery files:', err)
    }
  }

  private withdrawDiscovery(): void {
    if (!this.discovery) return
    try {
      removeDiscovery(this.discovery.userDataDir)
    } catch (err) {
      console.warn('[mcp] could not remove the agent discovery files:', err)
    }
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if (!this.token) return false
    // 인증 스킴 이름은 대소문자를 구분하지 않는다(RFC 7235). 토큰만 timingSafeEqual로 비교한다.
    const match = /^bearer (.*)$/i.exec(req.headers.authorization ?? '')
    if (!match) return false
    const expected = Buffer.from(this.token)
    const actual = Buffer.from(match[1])
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
