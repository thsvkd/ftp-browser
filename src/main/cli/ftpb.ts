import path from 'path'
import { MCP_PORT } from '@shared/constants'
import { AGENT_CLIENT_IDS, buildClientSetups, buildSkillMarkdown } from '@shared/agentClients'
import {
  defaultUserDataDir,
  discoverEndpoint,
  tokenFilePath,
  type DiscoveredEndpoint
} from '../agent/discovery'
import { installSkill } from '../agent/cliInstall'
import {
  APP_NOT_RUNNING,
  EndpointUnavailableError,
  JsonRpcError,
  McpSession,
  type Endpoint
} from './mcpClient'
import { saveImages, type SavedImage } from './imageFiles'
import { runStdioBridge } from './stdioBridge'
import {
  UsageError,
  parseToolArgs,
  policyOf,
  resolveName,
  tierOf,
  toolHelp,
  type ToolInfo
} from './toolArgs'

/**
 * `ftpb`: the FTP Browser command line (docs/handoff/agent-operations.md §2.6 L1–L4). A thin MCP
 * client of the app's own endpoint, so every call goes through the app's tool registry and policy.
 * Never prompts; JSON when piped; fixed exit codes.
 */

export const EXIT = { OK: 0, TOOL_ERROR: 1, USAGE: 2, DENIED: 3, UNAVAILABLE: 4 } as const

/**
 * Tool error codes that mean FTP Browser refused to run the call: DENIED_* and CONFIRMATION_*
 * (exit 3, §2.6 L3, §9 R10). BUSY, SESSION_CHANGED and PLAN_CHANGED are errors to retry (exit 1).
 */
const isRefusal = (code: string): boolean => /^(DENIED|CONFIRMATION)_/.test(code)

/** Replaced at build time (script/build-cli.mjs) with the app version. */
const CLI_VERSION = process.env.FTPB_VERSION ?? 'dev'

export interface FtpbIo {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  /** The OS temp folder: image blocks are saved in <tmpdir>/ftpb-previews unless --save-dir says otherwise. */
  tmpdir: string
  stdin: NodeJS.ReadableStream
  stdout: { write(chunk: string): unknown; isTTY?: boolean }
  stderr: { write(chunk: string): unknown }
  fetch: typeof fetch
  /** How to start this ftpb without a shell, for stdio client snippets (`ftpb setup`). */
  self: { command: string; args: string[]; env?: Record<string, string> }
}

const HELP = `ftpb - command line for the FTP Browser desktop app

FTP Browser must be running with Agent access on (Settings › Enable MCP server).
Every tool runs inside the app, under the app's policy, and the app window shows
what happens.

Usage:
  ftpb tools                          tools with their risk tier and current policy
  ftpb <tool> [--param value ...]     run a tool; kebab or snake case (list-directory)
  ftpb <tool> --help                  a tool's parameters
  ftpb call <tool> [--args '<json>' | --args -] [--param value ...]
  ftpb status                         connection, running jobs and the policy per tier
  ftpb auth header [--value]          {"Authorization":"Bearer <token>"} (Claude Code
                                      headersHelper); --value prints only "Bearer <token>"
  ftpb auth token                     the raw token
  ftpb mcp-stdio                      stdio MCP bridge for stdio-only clients (Claude Desktop)
  ftpb setup [<client>] [--list]      config snippet for an agent client (notes on stderr)
  ftpb skill install [--dir <path>]   write the Agent Skill: <path>/ftp-browser/SKILL.md
                                      (default ~/.agents/skills and ~/.claude/skills)

Parameters follow the tool's schema: --limit 50, --recursive / --no-recursive, a list by
repeating a flag (--paths /a --paths /b) or as JSON (--paths '["/a","/b"]'), objects as JSON.
A parameter with several types takes the first its value reads as, else a string:
connect --server 3 sends the id 3, --server "Pixel phone" the name.
Every non-R tool takes --dry-run: it returns the plan and changes nothing.

--args - reads all parameters as one JSON object from stdin. Pass untrusted strings, such as
remote file names, that way and never as command-line arguments; above all on Windows, where
ftpb.cmd runs through cmd.exe, which re-parses quotes, &, | and % in arguments:
  ftpb call delete --args - < args.json

Output is JSON when stdout is not a terminal, or with --json; readable text otherwise.
A tool's JSON output is its structuredContent, printed once (the app also sends it as text).
Image blocks (get-image-previews) are saved as files in --save-dir <dir> (default:
ftpb-previews in the OS temp folder) and printed without base64 next to the data:
{"structuredContent":{...},"content":[{"type":"image","mimeType":...,"savedTo":"<file>"}]},
with the remote "path" when the result names it. Open the saved files to see the images.
--raw prints the result as the app sent it, base64 images included, and saves nothing.
Errors go to stderr. ftpb never prompts.

Example: the photos of 12 September (times are UTC; remote names go in stdin JSON)
  ftpb connect --server "Pixel phone" --dry-run   an id, name or host from list-servers
  ftpb connect --server "Pixel phone"
  ftpb list-directory --path /DCIM/Camera --kind images \\
    --modified-from 2026-09-12T00:00:00Z --modified-to 2026-09-12T23:59:59Z
  ftpb download --dry-run --args - < job.json     {"remotePaths":[...],"localDir":"<dir>"}
  ftpb download --args - < job.json               the same without --dry-run: a jobId
  ftpb wait-for-jobs --ids <jobId> --timeout-sec 45   repeat until allDone is true
  ftpb list-local-directory --path <dir>          compare the files with the plan

Risk tiers (the app decides; Settings › Permissions sets allow, ask or deny per tier):
  R  reads only; always allowed
  W  changes state without losing data: connect, create folder, rename, download, cancel
  D  destroys data: delete (FTP has no trash)
  X  sends local files to the server: upload
  C  credentials and saved servers
  allow runs at once, ask shows the user a dialog in FTP Browser, deny hides the tool.
  A local write (download target, new local folder, local rename) that lands
  outside the user's Downloads folder always asks the user, whatever the W policy
  (deny still refuses).

Exit codes:
  0  success
  1  the tool failed (isError) or the request failed. Among these errors:
     BUSY             FTP Browser is waiting for the user to answer a confirmation (or,
                      for disconnect, a transfer is running): retry after the user answers
     SESSION_CHANGED  the connection or the files changed while the user was deciding, so
     PLAN_CHANGED     FTP Browser stopped: look again (--dry-run) and run it again
  2  usage error: unknown command, tool or parameter, or a value the tool's schema rejects
  3  refused: DENIED_BY_POLICY, DENIED_BY_USER, CONFIRMATION_TIMEOUT,
     CONFIRMATION_UNAVAILABLE or CONFIRMATION_CANCELLED (do not retry unless the user asks)
  4  FTP Browser is not running, Agent access is off, the token was rejected, or the
     discovery file is stale (the app that wrote it is gone)

Environment: FTPB_URL and FTPB_TOKEN override the endpoint the app publishes in
<userData>/agent/ (endpoint.json, token). ftpb sends the token to an endpoint from
endpoint.json only while the app process that wrote it is running.
`

/** Where image blocks are saved (§10 U2), or `raw`: print the result as the app sent it. */
interface ImageOptions {
  raw: boolean
  dir: string
  isDefaultDir: boolean
}

class Output {
  constructor(
    private readonly io: FtpbIo,
    readonly json: boolean,
    readonly images: ImageOptions
  ) {}

  /** A result on stdout: compact JSON, or `human` (pretty JSON by default) on a terminal. */
  data(value: unknown, human?: string): void {
    if (this.json) this.io.stdout.write(`${JSON.stringify(value)}\n`)
    else this.io.stdout.write(human ?? `${JSON.stringify(value, null, 2)}\n`)
  }

  text(value: string): void {
    this.io.stdout.write(value)
  }

  note(value: string): void {
    this.io.stderr.write(value)
  }

  error(exit: number, code: string, message: string): number {
    this.io.stderr.write(
      this.json ? `${JSON.stringify({ error: { code, message } })}\n` : `ftpb: ${message}\n`
    )
    return exit
  }
}

function endpointOf(io: FtpbIo): DiscoveredEndpoint | null {
  return discoverEndpoint(io.platform, io.env, io.home)
}

/** Whether `pid` runs. EPERM: it does, as another user's process. */
function processAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The endpoint ftpb may send the token to. Files left by a crashed app are stale: whatever listens
 * on that port now must not get the token (§9 R10). FTPB_URL skips the check: the user chose it.
 */
function liveEndpoint(io: FtpbIo): DiscoveredEndpoint | null {
  const endpoint = endpointOf(io)
  if (endpoint && !io.env.FTPB_URL && !processAlive(endpoint.pid)) {
    throw new EndpointUnavailableError(
      `Stale discovery file: FTP Browser (pid ${String(endpoint.pid)}) is no longer running, so ` +
        'ftpb did not send the token. Start FTP Browser and turn on Agent access in Settings ' +
        '(Enable MCP server), then retry.'
    )
  }
  return endpoint
}

function requireEndpoint(io: FtpbIo): DiscoveredEndpoint {
  const endpoint = liveEndpoint(io)
  if (!endpoint) throw new EndpointUnavailableError(APP_NOT_RUNNING)
  return endpoint
}

/**
 * `--args -` (§9 R7): the JSON object comes from stdin, so no shell or cmd.exe parses untrusted
 * strings such as remote names. Puts the text read in place of `-` for parseToolArgs.
 */
async function withStdinArgs(argv: string[], stdin: FtpbIo['stdin']): Promise<string[]> {
  const fromStdin = (arg: string, i: number): boolean =>
    arg === '--args=-' || (arg === '-' && argv[i - 1] === '--args')
  if (!argv.some(fromStdin)) return argv
  if ((stdin as { isTTY?: boolean }).isTTY) {
    throw new UsageError(
      '--args - reads a JSON object from stdin, but stdin is a terminal. Pipe the JSON in: ' +
        'ftpb call <tool> --args - < args.json'
    )
  }
  const chunks: Buffer[] = []
  for await (const chunk of stdin)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  // PowerShell may write a UTF-8 BOM.
  const text = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    value = undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UsageError('--args - needs a JSON object on stdin, such as {"path":"/photos"}.')
  }
  return argv.map((arg, i) =>
    arg === '--args=-' ? `--args=${text}` : fromStdin(arg, i) ? text : arg
  )
}

async function listTools(session: McpSession): Promise<ToolInfo[]> {
  const tools: ToolInfo[] = []
  let cursor: string | undefined
  do {
    const page = await session.request('tools/list', cursor ? { cursor } : {})
    tools.push(...((page.tools as ToolInfo[] | undefined) ?? []))
    cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined
  } while (cursor)
  return tools
}

function firstText(result: Record<string, unknown>): string {
  const content = (result.content as Array<{ type?: string; text?: string }> | undefined) ?? []
  return content.find((item) => item.type === 'text')?.text ?? ''
}

/**
 * What a successful tool call prints, each piece of data once (§10 U2): structuredContent (the
 * app's text block is its JSON copy), else the text, parsed when it is JSON. Image blocks are
 * saved as files and printed as `{ type: 'image', mimeType, path?, savedTo }` beside the data:
 * `{ structuredContent, content }`. `--raw` prints the result as the app sent it.
 */
function toolOutput(
  result: Record<string, unknown>,
  images: ImageOptions
): { value: unknown; human: string } {
  const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
  if (images.raw) return { value: result, human: pretty(result) }
  const content = (result.content as Array<Record<string, unknown>> | undefined) ?? []
  const nonText = content.filter((item) => item.type !== 'text')
  const structured = result.structuredContent
  if (structured !== undefined && nonText.length === 0) {
    return { value: structured, human: pretty(structured) }
  }
  if (content.length === 1 && nonText.length === 0) {
    const text = String(content[0].text ?? '')
    try {
      const value = JSON.parse(text) as unknown
      return { value, human: pretty(value) }
    } catch {
      return { value: { content }, human: `${text}\n` }
    }
  }
  const blocks = saveImages(
    structured !== undefined ? nonText : content,
    structured,
    images.dir,
    images.isDefaultDir
  )
  const saved = blocks.filter((item): item is SavedImage => 'savedTo' in item)
  const human = [
    ...(structured !== undefined ? [pretty(structured).trimEnd()] : []),
    ...blocks
      .filter((item): item is Record<string, unknown> => !('savedTo' in item))
      .map((item) =>
        item.type === 'text'
          ? String(item.text)
          : `[${String(item.type)} ${String(item.mimeType ?? '')}, ${String(item.data ?? '').length} base64 chars]`
      ),
    ...(saved.length > 0
      ? [
          'Images saved (open these files to see them):',
          ...saved.map((item) => `  ${item.savedTo}`)
        ]
      : [])
  ].join('\n')
  const value =
    structured !== undefined
      ? { structuredContent: structured, content: blocks }
      : { content: blocks }
  return { value, human: `${human}\n` }
}

function toolResult(out: Output, result: Record<string, unknown>, unlisted?: string): number {
  if (result.isError === true) {
    const text = firstText(result) || 'The tool reported an error.'
    if (text.startsWith('Input validation error')) {
      // An unlisted tool (e.g. hidden by a deny policy) has no schema here, so flags went as strings.
      const hint = unlisted
        ? ` ${unlisted} is not in \`ftpb tools\` (FTP Browser may have turned it off; see \`ftpb status\`), so its flags could not be typed: pass lists as JSON (--paths '["/a"]') or all parameters with --args '<json>'.`
        : ''
      return out.error(EXIT.USAGE, 'INVALID_ARGUMENTS', text + hint)
    }
    const structured = result.structuredContent as { code?: unknown } | undefined
    const code =
      /^([A-Z][A-Z0-9_]{2,})\b/.exec(text)?.[1] ??
      (typeof structured?.code === 'string' ? structured.code : 'TOOL_ERROR')
    return out.error(isRefusal(code) ? EXIT.DENIED : EXIT.TOOL_ERROR, code, text)
  }
  if (result.resultType !== undefined && result.resultType !== 'complete') {
    return out.error(
      EXIT.TOOL_ERROR,
      'UNSUPPORTED_RESULT',
      `The tool asked for ${String(result.resultType)}, which ftpb cannot answer. Use an MCP client.`
    )
  }
  const { value, human } = toolOutput(result, out.images)
  out.data(value, human)
  return EXIT.OK
}

function session(io: FtpbIo, endpoint: Endpoint): McpSession {
  return new McpSession(endpoint, io.fetch, CLI_VERSION)
}

async function runTool(
  io: FtpbIo,
  out: Output,
  name: string,
  argv: string[],
  help: boolean
): Promise<number> {
  const mcp = session(io, requireEndpoint(io))
  const tools = await listTools(mcp)
  const resolved = resolveName(
    name,
    tools.map((t) => t.name)
  )
  const tool = tools.find((t) => t.name === resolved)
  if (help) {
    if (!tool) throw new UsageError(`Unknown tool ${name}. Run \`ftpb tools\` to see the tools.`)
    out.text(toolHelp(tool))
    return EXIT.OK
  }
  // Call unlisted tools anyway: a tool hidden by a deny policy answers DENIED_BY_POLICY.
  if (!tool && !/^[A-Za-z0-9_.-]+$/.test(name)) throw new UsageError(`Unknown tool ${name}.`)
  const args = parseToolArgs(await withStdinArgs(argv, io.stdin), tool?.inputSchema)
  const toolName = tool?.name ?? name.replace(/-/g, '_')
  let result: Record<string, unknown>
  try {
    result = await mcp.request('tools/call', { name: toolName, arguments: args })
  } catch (err) {
    if (!tool && err instanceof JsonRpcError && err.code === -32602) {
      throw new UsageError(`Unknown tool ${name}. Run \`ftpb tools\` to see the tools.`)
    }
    throw err
  }
  return toolResult(out, result, tool ? undefined : toolName)
}

async function runTools(io: FtpbIo, out: Output): Promise<number> {
  const tools = await listTools(session(io, requireEndpoint(io)))
  const rows = tools.map((tool) => ({
    name: tool.name,
    tier: tierOf(tool),
    policy: policyOf(tool),
    title: tool.title ?? '',
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? {}
  }))
  const width = Math.max(4, ...rows.map((row) => row.name.length))
  const table = [
    `${'TIER'.padEnd(5)} ${'POLICY'.padEnd(7)} ${'TOOL'.padEnd(width)}  TITLE`,
    ...rows.map((row) =>
      `${row.tier.padEnd(5)} ${row.policy.padEnd(7)} ${row.name.padEnd(width)}  ${row.title}`.trimEnd()
    ),
    '',
    'Run `ftpb <tool> --help` for its parameters. Tiers: R read, W reversible write,',
    'D destructive, X upload, C credentials. ask = the user confirms in FTP Browser.'
  ]
  out.data({ tools: rows }, `${table.join('\n')}\n`)
  return EXIT.OK
}

async function runStatus(io: FtpbIo, out: Output): Promise<number> {
  const endpoint = requireEndpoint(io)
  const result = await session(io, endpoint).request('tools/call', {
    name: 'get_status',
    arguments: {}
  })
  if (result.isError === true) return toolResult(out, result)
  const { url, pid, version } = endpoint
  const info = {
    endpoint: { url, ...(version ? { version } : {}), ...(pid ? { pid } : {}) },
    ...(toolOutput(result, out.images).value as Record<string, unknown>)
  }
  out.data(info)
  return EXIT.OK
}

function runAuth(io: FtpbIo, out: Output, argv: string[]): number {
  const [what, ...rest] = argv
  const valueOnly = rest.includes('--value')
  const unknown = rest.filter((arg) => arg !== '--value')
  if (
    (what !== 'header' && what !== 'token') ||
    unknown.length > 0 ||
    (valueOnly && what !== 'header')
  ) {
    throw new UsageError('Usage: ftpb auth header [--value] | ftpb auth token')
  }
  const { token } = requireEndpoint(io)
  if (what === 'token') out.text(`${token}\n`)
  else if (valueOnly) out.text(`Bearer ${token}\n`)
  // headersHelper wants "a JSON object of string key-value pairs" on stdout, terminal or not.
  else out.text(`${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`)
  return EXIT.OK
}

function runSetup(io: FtpbIo, out: Output, argv: string[]): number {
  const list = argv.includes('--list')
  const rest = argv.filter((arg) => arg !== '--list')
  if (rest.length > 1 || rest.some((arg) => arg.startsWith('-'))) {
    throw new UsageError('Usage: ftpb setup [<client>] [--list]')
  }
  const endpoint = endpointOf(io)
  const setups = buildClientSetups({
    url: endpoint?.url ?? `http://127.0.0.1:${MCP_PORT}/mcp`,
    token: endpoint?.token,
    ftpbCommand: 'ftpb',
    ftpbExec: io.self,
    tokenFile: tokenFilePath(defaultUserDataDir(io.platform, io.env, io.home)),
    home: io.home
  })
  const [client] = rest
  if (list || !client) {
    const clients = setups.map(({ id, title, kind, docsUrl }) => ({ id, title, kind, docsUrl }))
    const width = Math.max(...clients.map((c) => c.id.length))
    out.data(
      { clients },
      `${clients.map((c) => `${c.id.padEnd(width)}  ${c.kind.padEnd(5)}  ${c.title}`).join('\n')}\n`
    )
    return EXIT.OK
  }
  const setup = setups.find((s) => s.id === client)
  if (!setup) {
    throw new UsageError(`Unknown client ${client}. Clients: ${AGENT_CLIENT_IDS.join(', ')}.`)
  }
  if (out.json) {
    out.data(setup)
  } else {
    // On a terminal only the snippet goes to stdout (easy to copy); the notes go to stderr.
    out.text(`${setup.snippet}\n`)
    out.note(`\n# ${setup.title} (${setup.kind}): ${setup.notes}\n# Docs: ${setup.docsUrl}\n`)
  }
  return EXIT.OK
}

function runSkill(io: FtpbIo, out: Output, argv: string[]): number {
  const [action, ...rest] = argv
  let dir: string | undefined
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dir' && rest[i + 1] !== undefined) dir = rest[++i]
    else if (rest[i].startsWith('--dir=')) dir = rest[i].slice('--dir='.length)
    else throw new UsageError('Usage: ftpb skill install [--dir <skills folder>]')
  }
  if (action !== 'install')
    throw new UsageError('Usage: ftpb skill install [--dir <skills folder>]')
  const markdown = buildSkillMarkdown({ ftpbCommand: 'ftpb' })
  const paths = installSkill(io.home, markdown, dir ? [path.resolve(dir)] : undefined)
  out.data({ paths }, `Installed the FTP Browser skill:\n${paths.map((p) => `  ${p}\n`).join('')}`)
  return EXIT.OK
}

const COMMAND_USAGE: Record<string, string> = {
  tools: 'ftpb tools',
  call: "ftpb call <tool> [--args '<json>' | --args -] [--param value ...] [--dry-run]",
  status: 'ftpb status',
  auth: 'ftpb auth header [--value] | ftpb auth token',
  'mcp-stdio': 'ftpb mcp-stdio   (stdin/stdout: newline-delimited JSON-RPC; logs on stderr)',
  setup: 'ftpb setup [<client>] [--list]',
  skill: 'ftpb skill install [--dir <skills folder>]'
}

/** Runs one ftpb command line and resolves with its exit code. */
export async function runFtpb(argv: string[], io: FtpbIo): Promise<number> {
  const help = argv.includes('--help') || argv.includes('-h')
  const json = argv.includes('--json') || !io.stdout.isTTY
  let saveDir: string | undefined
  const args: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--save-dir') {
      const value = argv[i + 1]
      saveDir = value === undefined || value.startsWith('--') ? '' : argv[++i]
    } else if (arg.startsWith('--save-dir=')) saveDir = arg.slice('--save-dir='.length)
    else if (!['--help', '-h', '--json', '--raw'].includes(arg)) args.push(arg)
  }
  const out = new Output(io, json, {
    raw: argv.includes('--raw'),
    dir: saveDir ? path.resolve(saveDir) : path.join(io.tmpdir, 'ftpb-previews'),
    isDefaultDir: !saveDir
  })
  const [command, ...rest] = args
  try {
    if (saveDir === '') throw new UsageError('--save-dir needs a folder: --save-dir <dir>.')
    if (!command || command === 'help') {
      out.text(HELP)
      return EXIT.OK
    }
    if (help && COMMAND_USAGE[command] && !(command === 'call' && rest[0])) {
      out.text(
        `Usage: ${COMMAND_USAGE[command]}\n\nRun \`ftpb --help\` for exit codes and tiers.\n`
      )
      return EXIT.OK
    }
    switch (command) {
      case 'tools':
        return await runTools(io, out)
      case 'call':
        if (!rest[0] || rest[0].startsWith('-'))
          throw new UsageError(`Usage: ${COMMAND_USAGE.call}`)
        return await runTool(io, out, rest[0], rest.slice(1), help)
      case 'status':
        return await runStatus(io, out)
      case 'auth':
        return runAuth(io, out, rest)
      case 'mcp-stdio':
        await runStdioBridge({
          stdin: io.stdin,
          stdout: io.stdout,
          stderr: io.stderr,
          fetch: io.fetch,
          endpoint: () => liveEndpoint(io)
        })
        return EXIT.OK
      case 'setup':
        return runSetup(io, out, rest)
      case 'skill':
        return runSkill(io, out, rest)
      default:
        if (command.startsWith('-'))
          throw new UsageError(`Unknown option ${command}. Run ftpb --help.`)
        return await runTool(io, out, command, rest, help)
    }
  } catch (err) {
    if (err instanceof UsageError) return out.error(EXIT.USAGE, 'USAGE', err.message)
    if (err instanceof EndpointUnavailableError) {
      return out.error(EXIT.UNAVAILABLE, 'APP_UNAVAILABLE', err.message)
    }
    if (err instanceof JsonRpcError) {
      const usage = err.code === -32602 || err.code === -32601
      return out.error(usage ? EXIT.USAGE : EXIT.TOOL_ERROR, `JSONRPC_${-err.code}`, err.message)
    }
    return out.error(EXIT.TOOL_ERROR, 'ERROR', err instanceof Error ? err.message : String(err))
  }
}
