import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getCliStatus,
  installCli,
  installSkill,
  refreshInstalledCli,
  type CliInstallEnv
} from './cliInstall'

let home: string
let cliPath: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ftpb-install-'))
  cliPath = join(home, 'app', 'resources', 'app.asar.unpacked', 'out', 'cli', 'ftpb.cjs')
  mkdirSync(join(cliPath, '..'), { recursive: true })
  writeFileSync(cliPath, '#!/usr/bin/env node\n// ftpb v1\n')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function posixEnv(over: Partial<CliInstallEnv> = {}): CliInstallEnv {
  return {
    platform: 'linux',
    env: { PATH: '/usr/bin:/bin', SHELL: '/bin/bash' },
    home,
    execPath: '/opt/FTP Browser/ftp-browser',
    cliPath,
    run: vi.fn(async () => ''),
    ...over
  }
}

describe('installCli on macOS and Linux', () => {
  it('writes an executable sh shim in ~/.local/bin that runs the app as Node', async () => {
    // covers: Test-560
    const env = posixEnv()

    const status = await installCli(env)

    const shim = join(home, '.local', 'bin', 'ftpb')
    expect(status).toMatchObject({ installed: true, path: shim, onPath: false })
    const content = readFileSync(shim, 'utf8')
    expect(content.startsWith('#!/bin/sh\n')).toBe(true)
    expect(content).toContain(
      `ELECTRON_RUN_AS_NODE=1 exec "/opt/FTP Browser/ftp-browser" "${cliPath}" "$@"\n`
    )
    expect(statSync(shim).mode & 0o111).not.toBe(0)
    expect(status.pathHint).toBe(`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc`)
    expect(env.run).not.toHaveBeenCalled()
  })

  it('reports the folder on PATH and suggests the rc file of the user shell', async () => {
    // covers: Test-560
    const onPath = await installCli(
      posixEnv({ env: { PATH: `/usr/bin:${join(home, '.local', 'bin')}/`, SHELL: '/bin/zsh' } })
    )
    expect(onPath).toMatchObject({ installed: true, onPath: true })
    expect(onPath.pathHint).toBeUndefined()

    const zsh = await getCliStatus(posixEnv({ platform: 'darwin', env: { SHELL: '/bin/zsh' } }))
    expect(zsh.pathHint).toBe(`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`)
    const fish = await getCliStatus(posixEnv({ env: { SHELL: '/usr/bin/fish' } }))
    expect(fish.pathHint).toBe('fish_add_path $HOME/.local/bin')
  })

  it('points an AppImage shim at $APPIMAGE and a stable copy of the CLI', async () => {
    // covers: Test-560
    const appImage = join(home, 'Apps', 'ftp-browser-1.2.0-linux-x86_64.AppImage')
    const env = posixEnv({
      env: { PATH: '/usr/bin', APPIMAGE: appImage },
      execPath: '/tmp/.mount_ftpXYZ/ftp-browser',
      cliPath
    })

    await installCli(env)

    const copy = join(home, '.local', 'share', 'ftp-browser', 'ftpb.cjs')
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(cliPath, 'utf8'))
    const shim = readFileSync(join(home, '.local', 'bin', 'ftpb'), 'utf8')
    expect(shim).toContain(`ELECTRON_RUN_AS_NODE=1 exec "${appImage}" "${copy}" "$@"`)
    expect(shim).not.toContain('.mount_')
  })

  it('escapes characters that a double-quoted sh string would expand', async () => {
    // covers: Test-560
    await installCli(posixEnv({ execPath: '/opt/a"b$c`d\\e/ftp-browser' }))

    const shim = readFileSync(join(home, '.local', 'bin', 'ftpb'), 'utf8')
    expect(shim).toContain('exec "/opt/a\\"b\\$c\\`d\\\\e/ftp-browser"')
  })

  it('reports an error instead of a shim when the bundled CLI is missing', async () => {
    // covers: Test-560
    rmSync(cliPath)

    const status = await installCli(posixEnv())

    expect(status.installed).toBe(false)
    expect(status.error).toMatch(/ftpb\.cjs/)
    expect(existsSync(join(home, '.local', 'bin', 'ftpb'))).toBe(false)
  })
})

describe('installCli on Windows', () => {
  function winEnv(userPath: string, over: Partial<CliInstallEnv> = {}): CliInstallEnv {
    const localAppData = join(home, 'AppData', 'Local')
    return {
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\system32', LOCALAPPDATA: localAppData },
      home,
      execPath: 'C:\\Users\\u\\AppData\\Local\\Programs\\ftp-browser\\ftp-browser.exe',
      cliPath,
      run: vi.fn(async (_file: string, args: string[]) =>
        args.join(' ').includes('SetValue') ? '' : userPath
      ),
      ...over
    }
  }

  it('writes ftpb.cmd and adds its folder to the user PATH without setx', async () => {
    // covers: Test-560
    const env = winEnv('C:\\Tools')
    const binDir = join(home, 'AppData', 'Local', 'ftp-browser', 'bin')

    const status = await installCli(env)

    const cmd = readFileSync(join(binDir, 'ftpb.cmd'), 'utf8')
    expect(cmd).toBe(
      '@echo off\r\nrem ftpb: FTP Browser command-line tool, written by FTP Browser\r\n' +
        'setlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n' +
        `"C:\\Users\\u\\AppData\\Local\\Programs\\ftp-browser\\ftp-browser.exe" "${cliPath}" %*\r\n` +
        'exit /b %ERRORLEVEL%\r\n'
    )
    const calls = vi.mocked(env.run).mock.calls
    const update = calls.find(([, args]) => args.join(' ').includes('SetValue'))
    expect(update).toBeDefined()
    const [file, args, runEnv] = update!
    expect(file).toBe('powershell.exe')
    expect(args.join(' ')).not.toMatch(/setx/i)
    expect(args.join(' ')).toContain('DoNotExpandEnvironmentNames')
    // 경로는 스크립트 문자열이 아니라 환경변수로 넘긴다(따옴표 주입 방지)
    expect(args.join(' ')).not.toContain(binDir)
    expect(runEnv).toEqual({ FTPB_BIN_DIR: binDir })
    // 새 터미널부터 PATH에 잡힌다. 사용자 PATH(레지스트리)에 있으면 onPath다
    expect(status).toMatchObject({ installed: true, path: join(binDir, 'ftpb.cmd'), onPath: true })
  })

  it('does not touch the user PATH when the folder is already there', async () => {
    // covers: Test-560
    const binDir = join(home, 'AppData', 'Local', 'ftp-browser', 'bin')
    const env = winEnv(`C:\\Tools;${binDir.toUpperCase()}\\`)

    const status = await installCli(env)

    expect(status.onPath).toBe(true)
    const calls = vi.mocked(env.run).mock.calls
    expect(calls.some(([, args]) => args.join(' ').includes('SetValue'))).toBe(false)
  })

  it('escapes % in the cmd shim and gives a PowerShell hint when the PATH update fails', async () => {
    // covers: Test-560
    const env = winEnv('', {
      execPath: 'C:\\100%\\ftp-browser.exe',
      run: vi.fn(async () => {
        throw new Error('powershell.exe not found')
      })
    })

    const status = await installCli(env)

    const cmd = readFileSync(status.path, 'utf8')
    expect(cmd).toContain('"C:\\100%%\\ftp-browser.exe"')
    expect(status).toMatchObject({ installed: true, onPath: false })
    expect(status.pathHint).toMatch(/SetEnvironmentVariable\('Path'/)
    expect(status.pathHint).not.toMatch(/setx/i)
  })
})

describe('refreshInstalledCli', () => {
  it('rewrites only a shim this app wrote', async () => {
    // covers: Test-567
    await installCli(posixEnv())
    const shim = join(home, '.local', 'bin', 'ftpb')

    await refreshInstalledCli(posixEnv({ execPath: '/opt/new/ftp-browser' }))
    expect(readFileSync(shim, 'utf8')).toContain('exec "/opt/new/ftp-browser"')

    writeFileSync(shim, '#!/bin/sh\necho mine\n')
    await refreshInstalledCli(posixEnv({ execPath: '/opt/newer/ftp-browser' }))
    expect(readFileSync(shim, 'utf8')).toBe('#!/bin/sh\necho mine\n')
  })

  it('does nothing when no shim is installed', async () => {
    // covers: Test-567
    await refreshInstalledCli(posixEnv())

    expect(existsSync(join(home, '.local', 'bin', 'ftpb'))).toBe(false)
  })
})

describe('installSkill', () => {
  it('writes SKILL.md under ~/.agents/skills and ~/.claude/skills, replacing only its own file', () => {
    // covers: Test-561
    const ours = join(home, '.claude', 'skills', 'ftp-browser')
    mkdirSync(ours, { recursive: true })
    writeFileSync(join(ours, 'SKILL.md'), 'old')
    writeFileSync(join(ours, 'notes.md'), 'user notes')
    const other = join(home, '.claude', 'skills', 'other', 'SKILL.md')
    mkdirSync(join(other, '..'), { recursive: true })
    writeFileSync(other, 'other skill')

    const paths = installSkill(home, '---\nname: ftp-browser\n---\nnew\n')

    expect(paths).toEqual([
      join(home, '.agents', 'skills', 'ftp-browser', 'SKILL.md'),
      join(home, '.claude', 'skills', 'ftp-browser', 'SKILL.md')
    ])
    for (const p of paths)
      expect(readFileSync(p, 'utf8')).toBe('---\nname: ftp-browser\n---\nnew\n')
    expect(readFileSync(join(ours, 'notes.md'), 'utf8')).toBe('user notes')
    expect(readFileSync(other, 'utf8')).toBe('other skill')
  })

  it('installs into the given skills folders instead', () => {
    // covers: Test-561
    const dir = join(home, 'project', '.agents', 'skills')

    expect(installSkill(home, 'x', [dir])).toEqual([join(dir, 'ftp-browser', 'SKILL.md')])
    expect(existsSync(join(home, '.agents'))).toBe(false)
  })
})
