/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import type { AgentClientSetup, AgentPolicy, CliInstallStatus } from '@shared/types/agent'
import type { McpState } from '@shared/types/mcp'
import { SettingsDialog } from './SettingsDialog'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

const MCP_URL = 'http://127.0.0.1:47821/mcp'
/** McpService가 만드는 것과 같은 모양(32바이트 base64url). */
const TOKEN = 'Zx9_Q-4rT1vB8nK2mP0sL7wY3hJ6cF5dA1eG9iU0oR4'
const CLI_PATH = '/home/kim/.local/bin/ftpb'

const SETUPS: AgentClientSetup[] = [
  {
    id: 'claude-code',
    title: 'Claude Code',
    kind: 'http',
    snippet: `claude mcp add --transport http ftp-browser ${MCP_URL} --header-helper "ftpb auth header"`,
    notes: 'Run this in a terminal.',
    docsUrl: 'https://code.claude.com/docs/en/mcp'
  },
  {
    id: 'gemini-cli',
    title: 'Gemini CLI',
    kind: 'http',
    snippet: `{"mcpServers":{"ftp-browser":{"httpUrl":"${MCP_URL}","headers":{"Authorization":"Bearer ${TOKEN}"}}}}`,
    notes: 'Add this to ~/.gemini/settings.json.',
    docsUrl: 'https://github.com/google-gemini/gemini-cli'
  }
]

interface Channels {
  policy: AgentPolicy
  cli: CliInstallStatus
  handlers: Record<string, (...args: unknown[]) => unknown>
}

const mockInvoke = vi.fn()

function serve(overrides: Partial<Channels> = {}): Channels {
  const state: Channels = {
    policy: { W: 'allow', D: 'ask', X: 'deny', C: 'ask' },
    cli: { installed: false, path: CLI_PATH, onPath: false },
    handlers: {},
    ...overrides
  }
  const mcp: McpState = {
    enabled: true,
    running: true,
    url: MCP_URL,
    command: `claude mcp add --scope user --transport http ftp-browser ${MCP_URL} --header "Authorization: Bearer ${TOKEN}"`
  }
  mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
    const handler = state.handlers[channel]
    if (handler) return handler(...args)
    const ok = (data: unknown): Promise<unknown> => Promise.resolve({ success: true, data })
    switch (channel) {
      case 'cache:getStats':
        return ok({ totalBytes: 0, totalCount: 0 })
      case 'update:getState':
        return ok({ status: 'idle', currentVersion: '1.0.5' })
      case 'mcp:getState':
        return ok(mcp)
      case 'agent:getPolicy':
        return ok(state.policy)
      case 'agent:setPolicy':
        state.policy = args[0] as AgentPolicy
        return ok(state.policy)
      case 'agent:getClientSetups':
        return ok(SETUPS)
      case 'agent:getCliStatus':
        return ok(state.cli)
      default:
        return ok(undefined)
    }
  })
  return state
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('api', makeApiMock(mockInvoke))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const policySelect = (name: string): Promise<HTMLSelectElement> =>
  screen.findByRole('combobox', { name }) as Promise<HTMLSelectElement>

describe('Settings › Agent access', () => {
  it('shows the current policy per tier and saves a change through agent:setPolicy', async () => {
    // covers: Test-508
    serve()
    const user = userEvent.setup()
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    const destructive = await policySelect('Destructive')
    await waitFor(() => expect(destructive.value).toBe('ask'))
    expect((await policySelect('Change')).value).toBe('allow')
    expect((await policySelect('Upload')).value).toBe('deny')
    expect((await policySelect('Server settings')).value).toBe('ask')
    // 읽기 등급은 고를 수 없고 항상 허용이다.
    expect(screen.queryByRole('combobox', { name: 'Read only' })).toBeNull()
    expect(screen.getByText('Always allowed')).toBeTruthy()

    await user.selectOptions(destructive, 'deny')

    expect(invokeCalls(mockInvoke, 'agent:setPolicy')).toEqual([
      [{ W: 'allow', D: 'deny', X: 'deny', C: 'ask' }]
    ])
    await waitFor(() => expect(destructive.value).toBe('deny'))
  })

  it('shows the chosen client setup with the token masked and copies the real snippet', async () => {
    // covers: Test-509
    serve()
    const user = userEvent.setup()
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    const client = (await screen.findByRole('combobox', { name: 'Agent' })) as HTMLSelectElement
    await waitFor(() => expect(client.value).toBe('claude-code'))
    expect(screen.getByText(SETUPS[0].snippet)).toBeTruthy()

    await user.selectOptions(client, 'gemini-cli')
    const code = screen.getByRole('region', { name: 'Setup for Gemini CLI' })
    expect(code.textContent).toContain('"Authorization":"Bearer ')
    expect(screen.getByText('Add this to ~/.gemini/settings.json.')).toBeTruthy()
    const docs = screen.getByRole('link', { name: 'Gemini CLI documentation' })
    expect(docs.getAttribute('href')).toBe(SETUPS[1].docsUrl)

    await user.click(screen.getByRole('button', { name: 'Copy setup' }))

    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(SETUPS[1].snippet))
    expect(toast.success).toHaveBeenCalledWith('Setup copied')
    expect(document.body.textContent).not.toContain(TOKEN)
  })

  it('installs the command-line tool and shows its state, the PATH hint or the error', async () => {
    // covers: Test-510
    const hint = 'export PATH="$HOME/.local/bin:$PATH"'
    const state = serve()
    const user = userEvent.setup()
    state.handlers['agent:installCli'] = () =>
      Promise.resolve({
        success: true,
        data: { installed: true, path: CLI_PATH, onPath: false, pathHint: hint }
      })
    const { unmount } = render(<SettingsDialog open={true} onClose={vi.fn()} />)

    const cli = await screen.findByRole('group', { name: 'Command-line tool' })
    expect(await within(cli).findByText('Not installed')).toBeTruthy()
    await user.click(within(cli).getByRole('button', { name: 'Install' }))

    expect(invokeCalls(mockInvoke, 'agent:installCli')).toEqual([[]])
    expect(await within(cli).findByText(`Installed at ${CLI_PATH}`)).toBeTruthy()
    expect(within(cli).getByText(hint)).toBeTruthy()
    expect(within(cli).getByRole('button', { name: 'Reinstall' })).toBeTruthy()
    unmount()

    serve({ cli: { installed: true, path: CLI_PATH, onPath: true } })
    const view = render(<SettingsDialog open={true} onClose={vi.fn()} />)
    const installed = await screen.findByRole('group', { name: 'Command-line tool' })
    expect(await within(installed).findByText(`Installed at ${CLI_PATH}`)).toBeTruthy()
    expect(within(installed).queryByText(/PATH/)).toBeNull()
    view.unmount()

    serve({
      cli: { installed: false, path: CLI_PATH, onPath: false, error: 'EACCES: permission denied' }
    })
    render(<SettingsDialog open={true} onClose={vi.fn()} />)
    const failed = await screen.findByRole('group', { name: 'Command-line tool' })
    expect(
      await within(failed).findByText('Installation failed. EACCES: permission denied')
    ).toBeTruthy()
  })

  it('reloads the setup snippets after installing the command-line tool', async () => {
    // covers: Test-650
    const state = serve()
    // PATH에 없는 곳에 설치하면 스니펫이 셔임의 절대 경로를 쓴다.
    const absolute = SETUPS[0].snippet.replace('"ftpb auth header"', `"${CLI_PATH} auth header"`)
    let installed = false
    state.handlers['agent:getClientSetups'] = () =>
      Promise.resolve({
        success: true,
        data: installed ? [{ ...SETUPS[0], snippet: absolute }, SETUPS[1]] : SETUPS
      })
    state.handlers['agent:installCli'] = () => {
      installed = true
      return Promise.resolve({
        success: true,
        data: { installed: true, path: CLI_PATH, onPath: false }
      })
    }
    const user = userEvent.setup()
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    expect(await screen.findByText(SETUPS[0].snippet)).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: 'Install' }))

    expect(await screen.findByText(absolute)).toBeTruthy()
    expect(screen.queryByText(SETUPS[0].snippet)).toBeNull()
  })

  it('installs the agent skill and lists where it went', async () => {
    // covers: Test-514
    const paths = ['/home/kim/.agents/skills/ftp-browser', '/home/kim/.claude/skills/ftp-browser']
    const state = serve()
    state.handlers['agent:installSkill'] = () => Promise.resolve({ success: true, data: { paths } })
    const user = userEvent.setup()
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: 'Install agent skill' }))

    expect(invokeCalls(mockInvoke, 'agent:installSkill')).toEqual([[]])
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Agent skill installed', {
        description: paths.join('\n')
      })
    )
  })

  it('shows error toasts instead of failing silently', async () => {
    // covers: Test-515
    const state = serve()
    state.handlers['agent:setPolicy'] = () =>
      Promise.resolve({ success: false, error: 'SQLITE_BUSY: database is locked' })
    state.handlers['agent:installCli'] = () => Promise.reject(new Error('IPC channel closed'))
    state.handlers['agent:installSkill'] = () =>
      Promise.resolve({ success: false, error: 'EACCES: permission denied' })
    const user = userEvent.setup()
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    const destructive = await policySelect('Destructive')
    await waitFor(() => expect(destructive.value).toBe('ask'))
    await user.selectOptions(destructive, 'allow')
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't change the permission", {
        description: 'SQLITE_BUSY: database is locked'
      })
    )
    // 저장되지 않은 값을 보여 주지 않는다.
    expect(destructive.value).toBe('ask')

    state.handlers['agent:setPolicy'] = () => Promise.reject(new Error('IPC channel closed'))
    await user.selectOptions(destructive, 'deny')
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't change the permission", {
        description: 'IPC channel closed'
      })
    )
    expect(destructive.value).toBe('ask')

    await user.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't install the command-line tool", {
        description: 'IPC channel closed'
      })
    )

    await user.click(screen.getByRole('button', { name: 'Install agent skill' }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't install the agent skill", {
        description: 'EACCES: permission denied'
      })
    )

    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
      new Error('Document is not focused.')
    )
    await user.click(screen.getByRole('button', { name: 'Copy setup' }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't copy the command", {
        description: 'Document is not focused.'
      })
    )
    expect(toast.success).not.toHaveBeenCalled()
  })
})
