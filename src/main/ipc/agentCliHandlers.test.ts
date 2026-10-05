import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const paths = vi.hoisted(() => ({ home: '', userData: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (name: string) => (name === 'home' ? paths.home : paths.userData)
  },
  ipcMain: { handle: vi.fn() }
}))

import { ipcMain } from 'electron'
import { registerAgentCliHandlers } from './agentCliHandlers'
import type { AgentClientSetup } from '@shared/types/agent'

type Handler = (event: unknown, ...args: unknown[]) => unknown

let handlers: Map<string, Handler>

beforeEach(() => {
  vi.clearAllMocks()
  paths.home = mkdtempSync(join(tmpdir(), 'ftpb-ipc-'))
  paths.userData = join(paths.home, '.config', 'ftp-browser')
  handlers = new Map()
  vi.mocked(ipcMain.handle).mockImplementation(((channel: string, listener: Handler) => {
    handlers.set(channel, listener)
  }) as unknown as typeof ipcMain.handle)
})

afterEach(() => {
  rmSync(paths.home, { recursive: true, force: true })
})

async function invoke<T>(channel: string): Promise<{ success: boolean; data?: T; error?: string }> {
  return (await handlers.get(channel)?.(null)) as { success: boolean; data?: T; error?: string }
}

describe('registerAgentCliHandlers', () => {
  it('registers the four CLI channels', () => {
    // covers: Test-569
    registerAgentCliHandlers(() => null)

    expect([...handlers.keys()].sort()).toEqual([
      'agent:getCliStatus',
      'agent:getClientSetups',
      'agent:installCli',
      'agent:installSkill'
    ])
  })

  it('builds the client setups from the live endpoint, or says Agent access is off', async () => {
    // covers: Test-569
    let endpoint: { url: string; token: string } | null = null
    registerAgentCliHandlers(() => endpoint)

    const off = await invoke<AgentClientSetup[]>('agent:getClientSetups')
    expect(off.success).toBe(true)
    const offGemini = off.data!.find((s) => s.id === 'gemini-cli')!
    expect(offGemini.notes).toMatch(/Agent access is off/)
    expect(offGemini.snippet).toContain('http://127.0.0.1:47821/mcp')

    endpoint = { url: 'http://127.0.0.1:47821/mcp', token: 'live-token' }
    const on = await invoke<AgentClientSetup[]>('agent:getClientSetups')
    expect(on.data!.find((s) => s.id === 'gemini-cli')!.snippet).toContain('Bearer live-token')
    expect(on.data!.find((s) => s.id === 'grok-build')!.snippet).toContain(
      'bearer_token_file = "~/.config/ftp-browser/agent/token"'
    )
    const desktop = JSON.parse(on.data!.find((s) => s.id === 'claude-desktop')!.snippet)
    expect(desktop.mcpServers['ftp-browser'].command).toBe(process.execPath)
    expect(desktop.mcpServers['ftp-browser'].args[0]).toMatch(/[\\/]cli[\\/]ftpb\.cjs$/)
    expect(desktop.mcpServers['ftp-browser'].env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('reports status and installs the skill into the home folder', async () => {
    // covers: Test-569
    registerAgentCliHandlers(() => null)

    const status = await invoke<{ installed: boolean; path: string }>('agent:getCliStatus')
    expect(status).toMatchObject({ success: true, data: { installed: false } })
    const skill = await invoke<{ paths: string[] }>('agent:installSkill')
    expect(skill.data!.paths).toEqual([
      join(paths.home, '.agents', 'skills', 'ftp-browser', 'SKILL.md'),
      join(paths.home, '.claude', 'skills', 'ftp-browser', 'SKILL.md')
    ])
    expect(readFileSync(skill.data!.paths[0], 'utf8')).toMatch(/^---\nname: ftp-browser\n/)
  })

  it('returns failures as IpcResult values instead of rejecting the invoke', async () => {
    // covers: Test-569
    registerAgentCliHandlers(() => {
      throw new Error('boom')
    })

    await expect(invoke('agent:getClientSetups')).resolves.toMatchObject({
      success: false,
      error: 'boom'
    })
  })
})
