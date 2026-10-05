import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import path from 'path'
import type { CliInstallStatus } from '@shared/types/agent'

/**
 * "명령줄 도구 설치"(docs/handoff/agent-operations.md §2.6 L5, L7). `ftpb` 셔임을 사용자 폴더에 쓰고
 * Windows는 사용자 PATH에 그 폴더를 더한다. 셔임은 앱 실행 파일을 Node로 돌린다
 * (`ELECTRON_RUN_AS_NODE=1 <앱> <cli> …`, VS Code `code` 셔임과 같은 방식). electron을 import하지 않는다.
 */
export interface CliInstallEnv {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
  /** 앱 실행 파일(process.execPath) */
  execPath: string
  /** 번들된 CLI(out/cli/ftpb.cjs, asar 밖으로 풀린 경로) */
  cliPath: string
  /** 프로그램을 실행하고 stdout을 돌려준다. `env`는 현재 환경에 더한다. Windows PATH 등록에만 쓴다. */
  run: (file: string, args: string[], env?: Record<string, string>) => Promise<string>
}

/** 셔임에 남기는 표식. 이 표식이 있는 셔임만 다시 쓴다(사용자가 바꾼 파일은 건드리지 않는다). */
const MARKER = 'written by FTP Browser'
const POWERSHELL = 'powershell.exe'
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

/**
 * HKCU\Environment의 Path에 `$env:FTPB_BIN_DIR`를 더한다. `setx`는 1024자에서 PATH를 잘라 버리므로
 * 쓰지 않는다. %VAR%가 든 기존 값을 펼치지 않고(REG_EXPAND_SZ 유지) 그대로 둔 채 끝에 붙인다.
 * 마지막 두 줄은 WM_SETTINGCHANGE를 보내 새로 여는 터미널이 바뀐 PATH를 읽게 한다.
 */
const ADD_TO_USER_PATH = [
  '$dir = $env:FTPB_BIN_DIR',
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
  "$old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "$parts = @($old -split ';' | Where-Object { $_ -ne '' })",
  'if ($parts -notcontains $dir) {',
  "  $kind = if ($old -eq '') { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { $key.GetValueKind('Path') }",
  "  $key.SetValue('Path', (($parts + $dir) -join ';'), $kind)",
  '}',
  '$key.Close()',
  "[Environment]::SetEnvironmentVariable('FTPB_PATH_REFRESH', '1', 'User')",
  "[Environment]::SetEnvironmentVariable('FTPB_PATH_REFRESH', $null, 'User')"
].join('; ')
const READ_USER_PATH = "[Environment]::GetEnvironmentVariable('Path', 'User')"

function shimLocation(e: CliInstallEnv): { dir: string; file: string } {
  if (e.platform === 'win32') {
    const base = e.env.LOCALAPPDATA || path.join(e.home, 'AppData', 'Local')
    const dir = path.join(base, 'ftp-browser', 'bin')
    return { dir, file: path.join(dir, 'ftpb.cmd') }
  }
  const dir = path.join(e.home, '.local', 'bin')
  return { dir, file: path.join(dir, 'ftpb') }
}

/**
 * 셔임과 stdio 설정이 실행할 프로그램과 CLI 파일. AppImage는 실행할 때마다 다른 임시 경로에 마운트되므로
 * 실행 파일은 `$APPIMAGE`(AppImage 파일 자체)를, CLI는 고정 위치로 복사한 사본을 쓴다.
 */
function cliRuntime(e: CliInstallEnv): { exe: string; cli: string } {
  const appImage = e.platform === 'linux' ? e.env.APPIMAGE : undefined
  if (!appImage) return { exe: e.execPath, cli: e.cliPath }
  const dataHome = e.env.XDG_DATA_HOME?.startsWith('/')
    ? e.env.XDG_DATA_HOME
    : path.join(e.home, '.local', 'share')
  return { exe: appImage, cli: path.join(dataHome, 'ftp-browser', 'ftpb.cjs') }
}

/** cliRuntime, making sure an AppImage's stable CLI copy exists and matches the running app. */
export function prepareCliRuntime(e: CliInstallEnv): { exe: string; cli: string } {
  const runtime = cliRuntime(e)
  if (runtime.cli !== e.cliPath && existsSync(e.cliPath)) {
    mkdirSync(path.dirname(runtime.cli), { recursive: true })
    copyFileSync(e.cliPath, runtime.cli)
  }
  return runtime
}

function shimContent(platform: NodeJS.Platform, exe: string, cli: string): string {
  if (platform === 'win32') {
    // 배치 파일에서 %는 변수 확장이다. 실행 파일 종료 코드를 그대로 돌려준다(exit code가 CLI 계약).
    const quote = (value: string): string => `"${value.replace(/%/g, '%%')}"`
    return [
      '@echo off',
      `rem ftpb: FTP Browser command-line tool, ${MARKER}`,
      'setlocal',
      'set ELECTRON_RUN_AS_NODE=1',
      `${quote(exe)} ${quote(cli)} %*`,
      'exit /b %ERRORLEVEL%',
      ''
    ].join('\r\n')
  }
  const quote = (value: string): string => `"${value.replace(/[\\"$`]/g, '\\$&')}"`
  return [
    '#!/bin/sh',
    `# ftpb: FTP Browser command-line tool, ${MARKER} (Settings > Agent access)`,
    `ELECTRON_RUN_AS_NODE=1 exec ${quote(exe)} ${quote(cli)} "$@"`,
    ''
  ].join('\n')
}

function writeShim(e: CliInstallEnv): void {
  const { dir, file } = shimLocation(e)
  const { exe, cli } = prepareCliRuntime(e)
  mkdirSync(dir, { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  rmSync(temp, { force: true })
  writeFileSync(temp, shimContent(e.platform, exe, cli), { mode: 0o755 })
  if (e.platform !== 'win32') chmodSync(temp, 0o755)
  renameSync(temp, file)
}

/** 우리 경로에 앱이 쓰지 않은(표식 없는) 무언가가 있다. 설치가 그것을 덮어쓰면 안 된다(§9 R10). */
function foreignShimAt(file: string): boolean {
  try {
    lstatSync(file)
  } catch {
    return false
  }
  try {
    return !readFileSync(file, 'utf8').includes(MARKER)
  } catch {
    // 폴더, 깨진 링크, 읽을 수 없는 파일: 우리 것이 아니다
    return true
  }
}

function pathContains(
  pathValue: string | undefined,
  dir: string,
  platform: NodeJS.Platform
): boolean {
  const win = platform === 'win32'
  const normalize = (value: string): string => {
    const trimmed = value.trim().replace(/[\\/]+$/, '')
    return win ? trimmed.toLowerCase() : trimmed
  }
  const target = normalize(dir)
  return (pathValue ?? '').split(win ? ';' : ':').some((entry) => normalize(entry) === target)
}

async function readWindowsUserPath(e: CliInstallEnv): Promise<string> {
  try {
    return await e.run(POWERSHELL, [...PS_ARGS, READ_USER_PATH])
  } catch {
    return ''
  }
}

function pathHint(e: CliInstallEnv, dir: string): string {
  if (e.platform === 'win32') {
    const literal = dir.replace(/'/g, "''")
    return `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${literal}', 'User')`
  }
  const shell = path.basename(e.env.SHELL ?? '')
  if (shell === 'fish') return 'fish_add_path $HOME/.local/bin'
  const rc =
    shell === 'zsh' ? '~/.zshrc' : e.platform === 'darwin' ? '~/.bash_profile' : '~/.bashrc'
  return `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ${rc}`
}

/**
 * 설치 여부와 PATH 상태. PATH는 앱 프로세스의 PATH로 판단하고, Windows는 사용자 PATH(레지스트리)도 본다.
 * macOS에서 Finder로 띄운 앱의 PATH는 셸의 PATH와 달라 onPath가 false로 보일 수 있다.
 */
export async function getCliStatus(e: CliInstallEnv): Promise<CliInstallStatus> {
  const { dir, file } = shimLocation(e)
  let onPath = pathContains(e.env.PATH ?? e.env.Path, dir, e.platform)
  if (!onPath && e.platform === 'win32') {
    onPath = pathContains(await readWindowsUserPath(e), dir, e.platform)
  }
  return {
    installed: existsSync(file),
    path: file,
    onPath,
    ...(onPath ? {} : { pathHint: pathHint(e, dir) })
  }
}

export async function installCli(e: CliInstallEnv): Promise<CliInstallStatus> {
  if (!existsSync(e.cliPath)) {
    return {
      ...(await getCliStatus(e)),
      error: `The bundled command-line tool is missing: ${e.cliPath}`
    }
  }
  const { file } = shimLocation(e)
  if (foreignShimAt(file)) {
    return {
      ...(await getCliStatus(e)),
      error: `${file} already exists and was not written by FTP Browser. Rename or remove it, then install again.`
    }
  }
  try {
    writeShim(e)
  } catch (err) {
    return { ...(await getCliStatus(e)), error: err instanceof Error ? err.message : String(err) }
  }
  const status = await getCliStatus(e)
  if (status.onPath || e.platform !== 'win32') return status
  const { dir } = shimLocation(e)
  try {
    await e.run(POWERSHELL, [...PS_ARGS, ADD_TO_USER_PATH], { FTPB_BIN_DIR: dir })
    // 새로 여는 터미널부터 적용된다
    return { installed: status.installed, path: status.path, onPath: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ...status, error: `Could not add ${dir} to the user PATH: ${message}` }
  }
}

/** 앱이 쓴 셔임이 있으면 지금 실행 파일을 가리키게 다시 쓴다(AppImage·포터블은 실행 위치가 바뀐다). */
export async function refreshInstalledCli(e: CliInstallEnv): Promise<void> {
  const { file } = shimLocation(e)
  let current: string
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    return
  }
  if (!current.includes(MARKER) || !existsSync(e.cliPath)) return
  writeShim(e)
}

/**
 * `SKILL.md`를 `<skills 폴더>/ftp-browser/SKILL.md`에 쓴다. 기본 폴더는 Codex·Gemini·opencode·pi·Goose·
 * Grok·VS Code가 읽는 `~/.agents/skills`와 Claude Code가 읽는 `~/.claude/skills`. 그 파일 하나만 덮어쓴다.
 */
export function installSkill(home: string, markdown: string, skillsDirs?: string[]): string[] {
  const dirs = skillsDirs ?? [
    path.join(home, '.agents', 'skills'),
    path.join(home, '.claude', 'skills')
  ]
  return dirs.map((skillsDir) => {
    const dir = path.join(skillsDir, 'ftp-browser')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'SKILL.md')
    writeFileSync(file, markdown)
    return file
  })
}
