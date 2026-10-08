import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

import { ipcMain } from 'electron'
import { buildCliCommand, bundledCliPath, registerMcpHandlers } from './mcpHandlers'
import type { McpService } from '../mcp/McpService'

type Handler = (event: unknown, ...args: unknown[]) => unknown

describe('registerMcpHandlers', () => {
  let handlers: Map<string, Handler>

  beforeEach(() => {
    vi.clearAllMocks()
    handlers = new Map()
    vi.mocked(ipcMain.handle).mockImplementation(((channel: string, listener: Handler) => {
      handlers.set(channel, listener)
    }) as unknown as typeof ipcMain.handle)
  })

  it('returns failures as IpcResult values instead of rejecting the invoke', async () => {
    // covers: Test-293
    const service = {
      getState: vi.fn(() => {
        throw new Error('SQLITE_BUSY: database is locked')
      }),
      setEnabled: vi.fn(async () => {
        throw new Error('SQLITE_BUSY: database is locked')
      }),
      regenerateToken: vi.fn(() => {
        throw new Error('SQLITE_BUSY: database is locked')
      })
    } as unknown as McpService

    registerMcpHandlers(service, 'ftpb-command')

    expect([...handlers.keys()].sort()).toEqual([
      'mcp:getState',
      'mcp:regenerateToken',
      'mcp:setEnabled'
    ])
    for (const [channel, args] of [
      ['mcp:getState', []],
      ['mcp:setEnabled', [true]],
      ['mcp:regenerateToken', []]
    ] as const) {
      await expect(
        Promise.resolve().then(() => handlers.get(channel)?.(null, ...args)),
        channel
      ).resolves.toEqual({
        success: false,
        error: 'SQLITE_BUSY: database is locked',
        code: 'UNKNOWN'
      })
    }
  })

  it('adds the CLI command to every state it returns', async () => {
    // covers: Test-751
    const state = { enabled: true, running: true, url: 'http://127.0.0.1:47821/mcp' }
    const service = {
      getState: vi.fn(() => state),
      setEnabled: vi.fn(async () => state),
      regenerateToken: vi.fn(() => state)
    } as unknown as McpService

    registerMcpHandlers(service, 'ELECTRON_RUN_AS_NODE=1 app cli')

    for (const [channel, args] of [
      ['mcp:getState', []],
      ['mcp:setEnabled', [true]],
      ['mcp:regenerateToken', []]
    ] as const) {
      await expect(
        Promise.resolve(handlers.get(channel)?.(null, ...args)),
        channel
      ).resolves.toEqual({
        success: true,
        data: { ...state, cliCommand: 'ELECTRON_RUN_AS_NODE=1 app cli' }
      })
    }
  })
})

describe('CLI command', () => {
  it('runs the bundled ftpb.cjs with the app executable as Node, quoted for the shell', () => {
    // covers: Test-750
    const mac = '/Applications/FTP Browser.app/Contents/MacOS/FTP Browser'
    const asarMain = '/Applications/FTP Browser.app/Contents/Resources/app.asar/out/main'
    const winExe = "C:\\Users\\O'Neil\\AppData\\Local\\Programs\\FTP Browser\\FTP Browser.exe"
    const winCli = "C:\\Users\\O'Neil\\ftpb.cjs"

    const cli = bundledCliPath(asarMain)

    expect(cli).toBe(
      '/Applications/FTP Browser.app/Contents/Resources/app.asar.unpacked/out/cli/ftpb.cjs'
    )
    expect(bundledCliPath('/repo/out/main')).toBe('/repo/out/cli/ftpb.cjs')
    expect(buildCliCommand('darwin', mac, cli)).toBe(`ELECTRON_RUN_AS_NODE=1 '${mac}' '${cli}'`)
    expect(buildCliCommand('linux', "/opt/it's/ftp-browser", '/opt/cli.cjs')).toBe(
      `ELECTRON_RUN_AS_NODE=1 '/opt/it'\\''s/ftp-browser' '/opt/cli.cjs'`
    )
    expect(buildCliCommand('win32', winExe, winCli)).toBe(
      `$env:ELECTRON_RUN_AS_NODE=1; & '${winExe.replace("'", "''")}' '${winCli.replace("'", "''")}'`
    )
  })
})
