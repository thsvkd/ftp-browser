import net, { type AddressInfo } from 'net'
import Database from 'better-sqlite3'
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { McpService } from '../../mcp/McpService'

/**
 * CLI 테스트용 MCP 엔드포인트. 앱과 같은 McpService(HTTP 경계·Bearer 인증)에 가짜 도구를 올린다.
 * 실제 도구와 무관하게 CLI의 변환·출력·exit code를 고정한다.
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

/** 가짜 `get_image_previews`가 `path`의 미리보기로 돌려주는 바이트(테스트가 저장된 파일과 비교한다) */
export function previewBytes(path: string): Buffer {
  return Buffer.from(`JPEG preview of ${path}`)
}

export async function startFakeAgentServer(): Promise<FakeAgentServer> {
  const calls: FakeAgentServer['calls'] = []
  const record = (tool: string, args: Record<string, unknown>): Record<string, unknown> => {
    calls.push({ tool, args })
    return { received: args }
  }

  const createToolServer = (): McpServer => {
    const server = new McpServer({ name: 'ftp-browser', version: '9.9.9' })
    server.registerTool(
      'get_status',
      {
        title: 'Get status',
        description: '[RISK: read-only]\nShow the connection.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
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
        description: '[RISK: read-only]\nList a directory.',
        inputSchema: z.object({
          path: z.string().describe('Absolute remote path'),
          limit: z.number().int().optional(),
          kind: z.enum(['all', 'files', 'directories']).optional(),
          recursive: z.boolean().optional(),
          names: z.array(z.string()).optional(),
          sizes: z.array(z.number()).optional(),
          filter: z.object({ minSize: z.number() }).optional()
        }),
        annotations: { readOnlyHint: true }
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
        description: '[RISK: DESTRUCTIVE — permanently deletes; FTP has no trash]\nDelete.',
        inputSchema: z.object({ paths: z.array(z.string()), recursive: z.boolean().optional() }),
        annotations: { readOnlyHint: false, destructiveHint: true }
      },
      async (args) => {
        record('delete', args)
        if (args.paths.includes('/fail'))
          return text('FTP_PERMISSION_DENIED: 550 Permission denied.', true)
        if (args.paths.includes('/busy'))
          return text('BUSY: Transfers are still running. Wait for them with wait_for_jobs.', true)
        const data = {
          deleted: args.paths,
          ...(args.recursive !== undefined ? { recursive: args.recursive } : {})
        }
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
      }
    )
    server.registerTool(
      'wait_for_jobs',
      {
        title: 'Wait for jobs',
        description: '[RISK: read-only]\nWait.',
        inputSchema: z.object({ ids: z.array(z.string()), timeoutSec: z.number().max(45) }),
        annotations: { readOnlyHint: true }
      },
      async (args) => {
        record('wait_for_jobs', args)
        return text('{"done":true}')
      }
    )
    // 실제 connect와 같은 server 스키마(정수∣문자열 유니언)
    server.registerTool(
      'connect',
      {
        title: 'Connect to a saved server',
        description: '[RISK: changes state, no data loss]\nConnect.',
        inputSchema: z.object({
          server: z.union([z.number().int().positive(), z.string().min(1).max(255)]),
          path: z.string().optional()
        }),
        annotations: { readOnlyHint: false, destructiveHint: false }
      },
      async (args) => {
        const data = record('connect', args)
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
      }
    )
    // 실제 get_image_previews처럼 previews(path·ok)와 같은 내용의 텍스트, ok 항목마다 이미지 블록.
    // mapped: false면 structuredContent 없이 이미지 블록만 준다(경로 대응이 없는 결과).
    server.registerTool(
      'get_image_previews',
      {
        title: 'Get image previews',
        description: '[RISK: read-only]\nPreviews.',
        inputSchema: z.object({ paths: z.array(z.string()), mapped: z.boolean().optional() }),
        annotations: { readOnlyHint: true }
      },
      async (args) => {
        record('get_image_previews', args)
        const previews = args.paths.map((path) =>
          path.endsWith('.txt')
            ? { path, ok: false, error: 'Not an image file.' }
            : { path, ok: true }
        )
        const images = previews
          .filter((preview) => preview.ok)
          .map(({ path }) => ({
            type: 'image' as const,
            data: previewBytes(path).toString('base64'),
            mimeType: 'image/jpeg'
          }))
        if (args.mapped === false) return { content: images }
        const data = { previews }
        return {
          content: [{ type: 'text', text: JSON.stringify(data) }, ...images],
          structuredContent: data
        }
      }
    )
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
