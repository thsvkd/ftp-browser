import * as z from 'zod/v4'
import type { ServerEditorRequest } from '@shared/types/agent'
import type { TransferStatus } from '@shared/types/transfer'
import type { SavedServerInfo } from '../../agent/types'
import { AGENT_FOLDER_RULE, actionTool, readTool, type ToolDefinition } from '../toolRegistry'
import { codedError, jsonResult } from '../toolResults'
import {
  READ_ONLY_RISK,
  hostLabel,
  remotePath,
  serverRef,
  serverSchema,
  serverSummary
} from './shared'

const policyValue = z.enum(['allow', 'ask', 'deny'])
const noControl = /^[^\p{Cc}]*$/u

function serverLabel(server: SavedServerInfo): string {
  const address = `${server.user}@${server.host}:${server.port}`
  return server.name ? `${server.name} (${address})` : address
}

const getStatus = readTool({
  name: 'get_status',
  tier: 'R',
  title: 'Get status',
  risk: READ_ONLY_RISK,
  openWorld: false,
  description:
    'Show what FTP Browser is doing: whether it is connected and to which saved server, host, ' +
    'port and user; how many transfers and file operations are pending, active, completed, ' +
    'failed or cancelled; the current policy for each risk tier (allow, ask or deny); and the ' +
    'agent folder: download, create_local_directory and rename_local follow the W policy only ' +
    'inside it and ask the user anywhere else. Call it first to learn whether you need to ' +
    'connect, and which tools will ask the user to confirm or are turned off. It never returns ' +
    'passwords.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    connection: z.object({
      status: z.enum(['disconnected', 'connecting', 'connected', 'error']),
      serverId: z.number().optional().describe('Saved server id, when connected to one'),
      host: z.string().optional(),
      port: z.number().optional(),
      user: z.string().optional()
    }),
    jobs: z
      .object({
        pending: z.number(),
        active: z.number(),
        completed: z.number(),
        failed: z.number(),
        cancelled: z.number()
      })
      .describe('Transfers and file operations in the app, by status'),
    policy: z
      .object({ R: policyValue, W: policyValue, D: policyValue, X: policyValue, C: policyValue })
      .describe('What happens when you call a tool of each risk tier'),
    agentFolder: z
      .object({ path: z.string(), rule: z.string() })
      .describe("The user's Downloads folder; local writes outside it ask the user first")
  }),
  run(_input, { deps }) {
    const session = deps.services.session.info()
    const connection = {
      status: session.status,
      ...(session.status === 'connected'
        ? {
            ...(session.serverId !== undefined ? { serverId: session.serverId } : {}),
            ...(session.host !== undefined ? { host: session.host } : {}),
            ...(session.port !== undefined ? { port: session.port } : {}),
            ...(session.user !== undefined ? { user: session.user } : {})
          }
        : {})
    }
    const jobs: Record<TransferStatus, number> = {
      pending: 0,
      active: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    }
    for (const { status } of deps.services.transfers.list()) jobs[status]++
    for (const { status } of deps.operations.getAll()) jobs[status]++
    return jsonResult({
      connection,
      jobs,
      policy: { R: 'allow', ...deps.policy.get() },
      agentFolder: { path: deps.localRoot, rule: AGENT_FOLDER_RULE }
    })
  }
})

const listServers = readTool({
  name: 'list_servers',
  tier: 'R',
  title: 'List saved servers',
  risk: READ_ONLY_RISK,
  openWorld: false,
  description:
    'List the FTP servers saved in FTP Browser, without their passwords. Pass an id, name or ' +
    'host from here to connect or delete_server. You cannot connect to a server that is not ' +
    'saved: to add one, call open_server_editor so the user can enter the password and save it.',
  inputSchema: z.object({}),
  outputSchema: z.object({ servers: z.array(serverSchema) }),
  run(_input, { deps }) {
    return jsonResult({ servers: deps.services.servers.list().map(serverSummary) })
  }
})

const connect = actionTool({
  name: 'connect',
  tier: 'W',
  title: 'Connect to a saved server',
  risk: 'switches the app to another FTP server; no files change',
  openWorld: true,
  uncounted: true,
  description:
    'Connect FTP Browser to one of the saved servers (id, name or host from list_servers) and ' +
    'open a folder, as if the user had picked it in the app; the app window follows. Without ' +
    '`path` it opens the folder last visited on that server, or /. It replaces any current ' +
    'connection, and fails with BUSY while transfers or file operations run: wait for them ' +
    'with wait_for_jobs or stop them with cancel_jobs. There is no way to connect to a host ' +
    'that is not saved.',
  inputSchema: z.object({
    server: serverRef,
    path: remotePath
      .optional()
      .describe('Folder to open; default: the folder last visited on that server, else /')
  }),
  outputSchema: z.object({ server: serverSchema, path: z.string().describe('Folder now open') }),
  plan({ server: ref, path }, { deps }) {
    const server = deps.services.servers.resolve(ref)
    const items = path !== undefined ? [{ path, kind: 'directory' as const }] : []
    return {
      data: { server, path },
      preview: { server: serverSummary(server), ...(path !== undefined ? { path } : {}) },
      confirm: { host: hostLabel(server.host, server.port), items, totalItems: items.length }
    }
  },
  async run(_input, { server, path }, { deps }) {
    const opened = await deps.services.session.connect(server.id, path)
    return { outcome: 'done', result: { server: serverSummary(server), path: opened.path } }
  }
})

const disconnect = actionTool({
  name: 'disconnect',
  tier: 'W',
  title: 'Disconnect',
  risk: 'closes the FTP connection; no files change',
  openWorld: true,
  uncounted: true,
  description:
    'Close the FTP connection FTP Browser has open; the app window shows it as disconnected. ' +
    'Remote tools then fail with NOT_CONNECTED until you connect again. It fails with BUSY ' +
    'while transfers or file operations run (also ones the user started): wait for them with ' +
    'wait_for_jobs or stop them with cancel_jobs. Use it when the user asks to disconnect, not ' +
    'between steps of a task.',
  inputSchema: z.object({}),
  outputSchema: z.object({ disconnected: z.boolean(), host: z.string().optional() }),
  plan(_input, { deps }) {
    const { status, host, port } = deps.services.session.info()
    const connected = status === 'connected'
    return {
      data: host,
      preview: { connected, ...(host !== undefined ? { host } : {}) },
      confirm: {
        ...(host !== undefined ? { host: hostLabel(host, port) } : {}),
        items: [],
        totalItems: 0
      }
    }
  },
  async run(_input, host, { deps }) {
    await deps.services.session.disconnect()
    return { outcome: 'done', result: { disconnected: true, ...(host ? { host } : {}) } }
  }
})

const openServerEditor = actionTool({
  name: 'open_server_editor',
  tier: 'C',
  title: 'Open the server editor',
  risk: "opens FTP Browser's saved-server editor pre-filled; the user types the password and saves",
  openWorld: false,
  uncounted: true,
  description:
    'Open the saved-server editor in FTP Browser with these fields filled in, so the user can ' +
    'add the server. The user types the password and presses save; you never see or send a ' +
    'password. The result only says the editor opened, not that a server was saved: after the ' +
    'user confirms, call list_servers to find it, then connect.',
  inputSchema: z.object({
    name: z.string().max(100).regex(noControl).optional().describe('Alias shown in the app'),
    host: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\p{Cc}\s]+$/u)
      .describe('Host name or IP'),
    port: z.number().int().min(1).max(65535).default(21),
    user: z.string().max(255).regex(noControl).default(''),
    secure: z.boolean().default(false).describe('FTPS (explicit TLS)')
  }),
  outputSchema: z.object({ opened: z.boolean(), next: z.string() }),
  plan({ name, host, port, user, secure }) {
    const request: ServerEditorRequest = {
      ...(name !== undefined ? { name } : {}),
      host,
      port,
      user,
      secure
    }
    return {
      data: request,
      preview: { ...request },
      confirm: { host: hostLabel(host, port), items: [], totalItems: 0 }
    }
  },
  async run(_input, request, { deps }) {
    if (!deps.notify.openServerEditor(request)) {
      return {
        outcome: 'failed',
        error: codedError(
          'WINDOW_UNAVAILABLE',
          'FTP Browser has no open window to show the server editor in.',
          'Ask the user to open the app window, then retry.'
        )
      }
    }
    return {
      outcome: 'done',
      result: {
        opened: true,
        next:
          'The user enters the password and saves in FTP Browser. Then call list_servers to ' +
          'find the new server.'
      }
    }
  }
})

const deleteServer = actionTool({
  name: 'delete_server',
  tier: 'C',
  destructive: true,
  title: 'Delete a saved server',
  risk: 'removes a saved server and its stored login from FTP Browser; files on the server stay',
  openWorld: false,
  description:
    'Remove a saved server (id, name or host from list_servers) from FTP Browser, with its ' +
    'stored login and recent folders. Files on the FTP server are not touched. Only use it ' +
    'when the user explicitly asked to remove that server; the login cannot be recovered.',
  inputSchema: z.object({ server: serverRef }),
  outputSchema: z.object({ deleted: serverSchema }),
  plan({ server: ref }, { deps }) {
    const server = deps.services.servers.resolve(ref)
    return {
      data: server,
      preview: { server: serverSummary(server) },
      confirm: {
        host: hostLabel(server.host, server.port),
        items: [{ path: serverLabel(server), kind: 'file' }],
        totalItems: 1
      }
    }
  },
  async run(_input, server, { deps }) {
    deps.services.servers.remove(server.id)
    return { outcome: 'done', result: { deleted: serverSummary(server) } }
  }
})

export const SESSION_TOOLS: ToolDefinition[] = [
  getStatus,
  listServers,
  connect,
  disconnect,
  openServerEditor,
  deleteServer
]
