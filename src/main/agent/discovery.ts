import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import path from 'path'

/**
 * 에이전트 엔드포인트 발견 파일(docs/handoff/agent-operations.md §2.6 L4). MCP가 listen 중일 때
 * `<userData>/agent/endpoint.json`({ url, pid, version })과 `<userData>/agent/token`(토큰 원문)을 둔다.
 * main(McpService)이 쓰고 지우며, `ftpb` CLI가 읽는다. 그래서 electron을 import하지 않는다.
 */

export interface DiscoveryInfo {
  url: string
  token: string
  pid: number
  version: string
}

export interface DiscoveredEndpoint {
  url: string
  token: string
  /** 발견 파일에서 읽었을 때만 있다(환경변수 FTPB_URL로 정하면 없다). */
  pid?: number
  version?: string
}

/**
 * Electron 앱 이름. userData는 `<appData>/<app.name>`이고 app.name은 package.json의 productName,
 * 없으면 name이다. electron-builder는 패키징한 package.json에 productName을 넣지 않으므로 개발 빌드와
 * 패키징 빌드 모두 `ftp-browser`다(Linux에서 out/ 빌드와 `electron-builder --dir` 산출물을 새 HOME으로
 * 실행해 확인. macOS·Windows도 같은 Electron 규칙을 따른다).
 */
const APP_NAME = 'ftp-browser'
const AGENT_DIR = 'agent'
const ENDPOINT_FILE = 'endpoint.json'
const TOKEN_FILE = 'token'

/** `<userData>/agent/token`. Grok Build `bearer_token_file`과 opencode `{file:}`가 직접 가리킨다. */
export function tokenFilePath(userDataDir: string): string {
  return path.join(userDataDir, AGENT_DIR, TOKEN_FILE)
}

/** 임시 파일에 0600으로 쓴 뒤 rename으로 바꿔 넣는다. 읽는 쪽은 반쯤 쓴 파일을 보지 않는다. */
function writeAtomic(file: string, data: string): void {
  const temp = `${file}.${process.pid}.tmp`
  rmSync(temp, { force: true })
  writeFileSync(temp, data, { mode: 0o600 })
  renameSync(temp, file)
}

export function writeDiscovery(userDataDir: string, info: DiscoveryInfo): void {
  const dir = path.join(userDataDir, AGENT_DIR)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mkdir의 mode는 새로 만들 때만 적용되므로 이미 있던 폴더도 좁힌다
  chmodSync(dir, 0o700)
  // 토큰을 먼저 쓴다. endpoint.json이 보이면 토큰도 이미 있다.
  writeAtomic(path.join(dir, TOKEN_FILE), info.token)
  const { url, pid, version } = info
  writeAtomic(path.join(dir, ENDPOINT_FILE), `${JSON.stringify({ url, pid, version })}\n`)
}

/** 이 프로세스가 쓴 파일만 지운다. 같은 userData를 쓰는 다른 인스턴스가 듣고 있으면 그대로 둔다. */
export function removeDiscovery(userDataDir: string): void {
  const dir = path.join(userDataDir, AGENT_DIR)
  const endpoint = readEndpointFile(dir)
  if (endpoint && endpoint.pid !== process.pid) return
  rmSync(path.join(dir, ENDPOINT_FILE), { force: true })
  rmSync(path.join(dir, TOKEN_FILE), { force: true })
}

function readEndpointFile(dir: string): { url: string; pid?: number; version?: string } | null {
  try {
    const data = JSON.parse(readFileSync(path.join(dir, ENDPOINT_FILE), 'utf8')) as unknown
    if (!data || typeof data !== 'object') return null
    const { url, pid, version } = data as Record<string, unknown>
    if (typeof url !== 'string' || url === '') return null
    return {
      url,
      ...(typeof pid === 'number' ? { pid } : {}),
      ...(typeof version === 'string' ? { version } : {})
    }
  } catch {
    return null
  }
}

function readToken(dir: string): string | null {
  try {
    const token = readFileSync(path.join(dir, TOKEN_FILE), 'utf8').trim()
    return token === '' ? null : token
  } catch {
    return null
  }
}

export function readDiscovery(userDataDir: string): DiscoveredEndpoint | null {
  const dir = path.join(userDataDir, AGENT_DIR)
  const endpoint = readEndpointFile(dir)
  const token = readToken(dir)
  return endpoint && token ? { ...endpoint, token } : null
}

/** Electron `app.getPath('userData')`와 같은 경로. `platform` 기준 구분자를 쓴다. */
export function defaultUserDataDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): string {
  if (platform === 'win32') {
    return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), APP_NAME)
  }
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', APP_NAME)
  }
  const xdg = env.XDG_CONFIG_HOME
  return path.posix.join(xdg?.startsWith('/') ? xdg : path.posix.join(home, '.config'), APP_NAME)
}

/** CLI의 엔드포인트: `FTPB_URL`·`FTPB_TOKEN`이 각각 우선하고, 없으면 userData의 발견 파일을 읽는다. */
export function discoverEndpoint(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): DiscoveredEndpoint | null {
  const file = readDiscovery(defaultUserDataDir(platform, env, home))
  const url = env.FTPB_URL || file?.url
  const token = env.FTPB_TOKEN || file?.token
  if (!url || !token) return null
  if (env.FTPB_URL) return { url, token }
  return { ...file, url, token }
}
