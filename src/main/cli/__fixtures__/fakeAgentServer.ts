import net, { type AddressInfo } from 'net'
import Database from 'better-sqlite3'
import { McpServer, type CallToolResult, type ListToolsResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { McpService } from '../../mcp/McpService'

/**
 * CLI 테스트용 MCP 엔드포인트. 앱과 같은 McpService(HTTP 경계·Bearer 인증)에 등급 `_meta`를 단
 * 가짜 도구를 올린다. 실제 도구 레지스트리(Tools 갈래)와 무관하게 CLI의 변환·출력·exit code를 고정한다.
 */
export interface FakeAgentServer {
  url: string
  token: string
  /** 도구 호출마다 받은 인자 */
  calls: Array<{ tool: string; args: Record<string, unknown> }>
  stop(): Promise<void>
}

async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) }
}

function risk(tier: string, policy: string): Record<string, unknown> {
  return { 'ftp-browser/risk': tier, 'ftp-browser/policy': policy }
}

/** tools/list에서 `name`을 뺀다. SDK의 원래 목록 핸들러에 답을 맡긴 뒤 거른다. */
function hideFromList(server: McpServer, name: string): void {
  const protocol = server.server as unknown as {
    _getRequestHandler(method: string): (request: unknown, ctx: unknown) => Promise<ListToolsResult>
  }
  const original = protocol._getRequestHandler('tools/list')
  server.server.setRequestHandler('tools/list', async (request, ctx) => {
    const result = await original(request, ctx)
    return { ...result, tools: result.tools.filter((tool) => tool.name !== name) }
  })
}

export async function startFakeAgentServer(): Promise<FakeAgentServer> {
  const calls: FakeAgentServer['calls'] = []
  const record = (tool: string, args: Record<string, unknown>): Record<string, unknown> => {
    calls.push({ tool, args })
    return { received: args }
  }

  const createToolServer = (): McpServer => {
    const server = new McpServer({ name: 'ftp-browser', version: '9.9.9' })
    // 정책 deny 도구처럼 등록은 하되 tools/list에서는 뺀다(Tools 갈래의 toolRegistry와 같은 방식)
    server.registerTool(
      'delete_local',
      {
        description: 'hidden by policy',
        inputSchema: z.object({ paths: z.array(z.string()) }),
        _meta: risk('D', 'deny')
      },
      async (args) => {
        record('delete_local', args)
        return text('DENIED_BY_POLICY: delete_local is turned off in FTP Browser.', true)
      }
    )
    server.registerTool(
      'get_status',
      {
        title: 'Get status',
        description: '[RISK R: reads only. Policy: allow — always runs.]\nShow the connection.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        _meta: risk('R', 'allow')
      },
      async () => {
        const data = { connection: { status: 'connected', host: 'nas.local' } }
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
      }
    )
    server.registerTool(
      'list_directory',
      {
        title: 'List remote directory',
        description: '[RISK R: reads only. Policy: allow — always runs.]\nList a directory.',
        inputSchema: z.object({
          path: z.string().describe('Absolute remote path'),
          limit: z.number().int().optional(),
          kind: z.enum(['all', 'files', 'directories']).optional(),
          recursive: z.boolean().optional(),
          names: z.array(z.string()).optional(),
          sizes: z.array(z.number()).optional(),
          filter: z.object({ minSize: z.number() }).optional()
        }),
        annotations: { readOnlyHint: true },
        _meta: risk('R', 'allow')
      },
      async (args) => {
        const data = record('list_directory', args)
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
      }
    )
    server.registerTool(
      'delete',
      {
        title: 'Delete remote files',
        description:
          '[RISK D: permanently deletes remote files. Policy: ask — the user confirms.]\nDelete.',
        inputSchema: z.object({ paths: z.array(z.string()), dryRun: z.boolean().optional() }),
        annotations: { readOnlyHint: false, destructiveHint: true },
        _meta: risk('D', 'ask')
      },
      async (args) => {
        record('delete', args)
        if (args.paths.includes('/denied'))
          return text('DENIED_BY_USER: The user declined in FTP Browser. Do not retry.', true)
        if (args.paths.includes('/timeout'))
          return text('CONFIRMATION_TIMEOUT: Nobody answered within 120 s.', true)
        if (args.paths.includes('/fail'))
          return text('FTP_PERMISSION_DENIED: 550 Permission denied.', true)
        // §9 R1·R10: 취소는 거부(exit 3), 나머지는 다시 시도할 수 있는 도구 오류(exit 1)
        if (args.paths.includes('/cancelled'))
          return text(
            'CONFIRMATION_CANCELLED: The call was cancelled before the user answered.',
            true
          )
        if (args.paths.includes('/busy'))
          return text('BUSY: FTP Browser is waiting for the user to answer a confirmation.', true)
        if (args.paths.includes('/session-changed'))
          return text('SESSION_CHANGED: The connection changed while the user was deciding.', true)
        if (args.paths.includes('/plan-changed'))
          return text('PLAN_CHANGED: The files changed after the plan was shown.', true)
        const data = { deleted: args.paths, dryRun: args.dryRun ?? false }
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
      }
    )
    server.registerTool(
      'wait_for_jobs',
      {
        title: 'Wait for jobs',
        description: '[RISK R: reads only. Policy: allow — always runs.]\nWait.',
        inputSchema: z.object({ ids: z.array(z.string()), timeoutSec: z.number().max(45) }),
        annotations: { readOnlyHint: true },
        _meta: risk('R', 'allow')
      },
      async (args, ctx) => {
        record('wait_for_jobs', args)
        const progressToken = ctx.mcpReq._meta?.progressToken
        if (progressToken !== undefined) {
          for (let progress = 1; progress <= 2; progress++)
            await ctx.mcpReq.notify({
              method: 'notifications/progress',
              params: { progressToken, progress, total: 2 }
            })
        }
        return text('{"done":true}')
      }
    )
    hideFromList(server, 'delete_local')
    return server
  }

  const db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  // 포트 0: OS가 고른 포트에 바로 연다. 빈 포트를 골라 닫은 뒤 다시 열면 그 사이에 다른 테스트
  // worker의 서버가 그 포트를 가져가 요청이 그쪽(다른 토큰)으로 갈 수 있다(Test-668).
  const service = new McpService(db, createToolServer, 0)
  const { url } = await service.setEnabled(true)
  const row = db.prepare("SELECT value FROM settings WHERE key = 'mcpToken'").get() as {
    value: string
  }
  return {
    url,
    token: row.value,
    calls,
    stop: async () => {
      await service.stop()
      db.close()
    }
  }
}

/** 아무도 듣지 않는 루프백 URL(앱이 꺼진 상태) */
export async function deadUrl(): Promise<string> {
  return `http://127.0.0.1:${await freePort()}/mcp`
}
