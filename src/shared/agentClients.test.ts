import { describe, expect, it } from 'vitest'
import {
  AGENT_CLIENT_IDS,
  LITERAL_TOKEN_CLIENTS,
  buildClientSetups,
  buildSkillMarkdown,
  type ClientSetupInput
} from './agentClients'

const TOKEN = 'tok_SECRET-123'
const INPUT: ClientSetupInput = {
  url: 'http://127.0.0.1:47821/mcp',
  token: TOKEN,
  ftpbCommand: 'ftpb',
  ftpbExec: {
    command: '/Applications/FTP Browser.app/Contents/MacOS/FTP Browser',
    args: ['/Applications/FTP Browser.app/Contents/Resources/app.asar.unpacked/out/cli/ftpb.cjs'],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  },
  tokenFile: '/Users/u/Library/Application Support/ftp-browser/agent/token',
  home: '/Users/u'
}

/** §2.6 L6의 클라이언트 전부 */
const L6_CLIENTS = [
  'Claude Code',
  'Claude Desktop',
  'OpenAI Codex',
  'Gemini CLI',
  'Qwen Code',
  'Grok Build',
  'opencode',
  'pi',
  'GitHub Copilot (VS Code)',
  'GitHub Copilot CLI',
  'Cursor',
  'Goose',
  'Crush',
  'Zed',
  'Cline',
  'Roo Code'
]

describe('buildClientSetups', () => {
  it('defines every L6 client, each snippet carries the URL, the token only where it must', () => {
    // covers: Test-558
    const setups = buildClientSetups(INPUT)

    expect(setups.map((s) => s.title)).toEqual(L6_CLIENTS)
    expect(setups.map((s) => s.id)).toEqual(AGENT_CLIENT_IDS)
    expect(new Set(setups.map((s) => s.id)).size).toBe(setups.length)
    expect([...LITERAL_TOKEN_CLIENTS].sort()).toEqual(['gemini-cli', 'qwen-code'])
    for (const setup of setups) {
      expect(setup.snippet, setup.id).toContain(INPUT.url)
      expect(['http', 'stdio', 'cli'], setup.id).toContain(setup.kind)
      expect(setup.notes.length, setup.id).toBeGreaterThan(20)
      expect(setup.docsUrl, setup.id).toMatch(/^https:\/\//)
      expect(setup.snippet.includes(TOKEN), setup.id).toBe(LITERAL_TOKEN_CLIENTS.includes(setup.id))
    }
  })

  it('reads the token through a helper in the http snippets that can', () => {
    // covers: Test-558
    const byId = Object.fromEntries(buildClientSetups(INPUT).map((s) => [s.id, s]))

    expect(byId['claude-code'].snippet).toContain('"headersHelper":"ftpb auth header"')
    expect(byId['codex'].snippet).toContain('http_headers_helper = "ftpb auth header"')
    expect(byId['grok-build'].snippet).toContain(
      'bearer_token_file = "~/Library/Application Support/ftp-browser/agent/token"'
    )
    expect(byId['opencode'].snippet).toContain(
      'Bearer {file:~/Library/Application Support/ftp-browser/agent/token}'
    )
    expect(byId['pi'].snippet).toContain('"!ftpb auth header --value"')
    expect(byId['crush'].snippet).toContain('"Bearer $(ftpb auth token)"')
    expect(byId['vscode-copilot'].snippet).toContain('${input:ftp-browser-token}')
    // Cline은 type을 빼면 레거시 SSE로 붙는다. 리서치 §2.4.6
    for (const id of ['claude-code', 'vscode-copilot', 'opencode'])
      expect(byId[id].kind, id).toBe('http')
  })

  it('runs the stdio bridge through the app executable so no token lands in the config', () => {
    // covers: Test-558
    const setups = buildClientSetups(INPUT).filter((s) => s.kind === 'stdio')

    expect(setups.map((s) => s.id).sort()).toEqual(
      ['claude-desktop', 'cline', 'copilot-cli', 'cursor', 'goose', 'roo-code', 'zed'].sort()
    )
    const desktop = JSON.parse(setups.find((s) => s.id === 'claude-desktop')!.snippet)
    expect(desktop).toEqual({
      mcpServers: {
        'ftp-browser': {
          command: INPUT.ftpbExec.command,
          args: [...INPUT.ftpbExec.args, 'mcp-stdio'],
          env: { ELECTRON_RUN_AS_NODE: '1', FTPB_URL: INPUT.url }
        }
      }
    })
  })

  it('says Agent access is off instead of carrying a token when there is none', () => {
    // covers: Test-565
    const setups = buildClientSetups({ ...INPUT, token: undefined })

    for (const setup of setups) {
      expect(setup.notes, setup.id).toMatch(/Agent access is off/)
      expect(setup.snippet, setup.id).not.toContain('undefined')
    }
    const gemini = setups.find((s) => s.id === 'gemini-cli')!
    expect(gemini.snippet).toContain('Bearer <turn on Agent access in FTP Browser>')
  })

  it('quotes Windows paths so the TOML and JSON snippets stay valid', () => {
    // covers: Test-566
    const win: ClientSetupInput = {
      ...INPUT,
      ftpbCommand: '"C:\\Users\\Kim Lee\\AppData\\Local\\ftp-browser\\bin\\ftpb.cmd"',
      ftpbExec: {
        command: 'C:\\Users\\Kim Lee\\AppData\\Local\\Programs\\ftp-browser\\ftp-browser.exe',
        args: [
          'C:\\Users\\Kim Lee\\AppData\\Local\\Programs\\ftp-browser\\resources\\app.asar.unpacked\\out\\cli\\ftpb.cjs'
        ],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      },
      tokenFile: 'C:\\Users\\Kim Lee\\AppData\\Roaming\\ftp-browser\\agent\\token',
      home: 'C:\\Users\\Kim Lee'
    }
    const byId = Object.fromEntries(buildClientSetups(win).map((s) => [s.id, s]))

    expect(byId['grok-build'].snippet).toContain(
      'bearer_token_file = "~/AppData/Roaming/ftp-browser/agent/token"'
    )
    expect(byId['codex'].snippet).toContain(
      'http_headers_helper = "\\"C:\\\\Users\\\\Kim Lee\\\\AppData\\\\Local\\\\ftp-browser\\\\bin\\\\ftpb.cmd\\" auth header"'
    )
    const cursor = JSON.parse(byId['cursor'].snippet)
    expect(cursor.mcpServers['ftp-browser'].command).toBe(win.ftpbExec.command)
    const claude = byId['claude-code'].snippet
    const json = /'(\{.*\})'/.exec(claude)?.[1]
    expect(JSON.parse(json ?? '').headersHelper).toBe(`${win.ftpbCommand} auth header`)
  })
})

describe('buildSkillMarkdown', () => {
  it('is an Agent Skill that explains tiers, dry runs, waiting on jobs and exit codes', () => {
    // covers: Test-559
    const md = buildSkillMarkdown({ ftpbCommand: 'ftpb' })

    const front = /^---\n([\s\S]*?)\n---\n/.exec(md)?.[1] ?? ''
    expect(front).toMatch(/^name: ftp-browser$/m)
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? ''
    expect(description.length).toBeGreaterThan(40)
    expect(description.length).toBeLessThanOrEqual(1024)
    expect(description).toMatch(/Use when/)
    const body = md.slice(md.indexOf('---', 4))
    for (const tier of ['R', 'W', 'D', 'X', 'C']) expect(body).toMatch(new RegExp(`\\b${tier}\\b`))
    expect(body).toContain('--dry-run')
    expect(body).toContain('wait_for_jobs')
    expect(body).toMatch(/untrusted/i)
    expect(body).toContain('DENIED_BY_USER')
    for (const code of ['0', '1', '2', '3', '4']) expect(body).toMatch(new RegExp(`\\| ${code} `))
  })

  it('tells the agent to pass untrusted strings as JSON on stdin, especially on Windows', () => {
    // covers: Test-639
    const md = buildSkillMarkdown({ ftpbCommand: 'ftpb' })

    expect(md).toContain("ftpb call <tool> --args - <<'EOF'")
    const rule = md.split('\n').find((line) => line.includes('--args -') && /untrusted/i.test(line))
    expect(rule).toBeDefined()
    expect(md).toMatch(/Windows/)
  })

  it('explains exit 3 with CONFIRMATION_CANCELLED, the errors to retry and the local root', () => {
    // covers: Test-641
    const md = buildSkillMarkdown({ ftpbCommand: 'ftpb' })

    const exit3 = md.split('\n').find((line) => line.startsWith('- Exit code 3')) ?? ''
    expect(exit3).toContain('CONFIRMATION_CANCELLED')
    expect(md).toMatch(/`BUSY`[^\n]*retry after the user answers/)
    expect(md).toMatch(/`SESSION_CHANGED`[^\n]*`PLAN_CHANGED`[^\n]*run it again/)
    expect(md).toMatch(/outside the user's Downloads folder[^\n]*asks the user/)
  })

  it('uses the given command in every example', () => {
    // covers: Test-559
    const md = buildSkillMarkdown({ ftpbCommand: '/home/u/.local/bin/ftpb' })

    expect(md).toContain('/home/u/.local/bin/ftpb status')
    expect(md).not.toMatch(/`ftpb /)
  })
})
