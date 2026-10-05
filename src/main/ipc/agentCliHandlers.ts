import { execFile } from 'child_process'
import path from 'path'
import { app, ipcMain } from 'electron'
import { MCP_PORT } from '@shared/constants'
import { buildClientSetups, buildSkillMarkdown } from '@shared/agentClients'
import type { AgentClientSetup, CliInstallStatus } from '@shared/types/agent'
import type { IpcResult } from '@shared/types/ipc'
import { readDiscovery, tokenFilePath } from '../agent/discovery'
import {
  getCliStatus,
  installCli,
  installSkill,
  prepareCliRuntime,
  refreshInstalledCli,
  type CliInstallEnv
} from '../agent/cliInstall'
import { ipcError } from '../utils/errorClassifier'

/** 지금 listen 중인 MCP 엔드포인트의 URL과 토큰. 에이전트 접근이 꺼져 있으면 null. */
export type EndpointGetter = () => { url: string; token: string } | null

/** out/main 옆의 out/cli/ftpb.cjs. 패키징된 앱에서는 asar 밖(app.asar.unpacked)에 풀려 있다. */
function bundledCliPath(): string {
  return path
    .join(__dirname, '..', 'cli', 'ftpb.cjs')
    .replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked')
}

function runFile(file: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 15_000 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim()))
    )
  })
}

function installEnv(): CliInstallEnv {
  return {
    platform: process.platform,
    env: process.env,
    home: app.getPath('home'),
    execPath: process.execPath,
    cliPath: bundledCliPath(),
    run: runFile
  }
}

/** 기본값: McpService가 listen 중에 쓰는 발견 파일. 이 프로세스가 쓴 것만 믿는다(이전 실행의 잔여 파일 제외). */
function discoveredEndpoint(): ReturnType<EndpointGetter> {
  const found = readDiscovery(app.getPath('userData'))
  return found && found.pid === process.pid ? { url: found.url, token: found.token } : null
}

/** PATH에 없으면 셔임의 절대경로로 부른다(공백이 있으면 따옴표). */
async function ftpbCommand(env: CliInstallEnv): Promise<string> {
  const status = await getCliStatus(env)
  if (!status.installed || status.onPath) return 'ftpb'
  return /\s/.test(status.path) ? `"${status.path}"` : status.path
}

/**
 * 설정 › 에이전트 접근의 "에이전트 연결"·"명령줄 도구"·"스킬" (docs/handoff/agent-operations.md §2.7).
 * `getEndpoint`가 null이면(에이전트 접근 꺼짐) 스니펫은 토큰 대신 켜라는 안내를 담는다.
 */
export function registerAgentCliHandlers(getEndpoint: EndpointGetter = discoveredEndpoint): void {
  // 패키징된 앱만: 설치해 둔 셔임이 이번 실행 파일을 가리키게 한다(AppImage·포터블은 위치가 바뀐다)
  if (app.isPackaged) {
    refreshInstalledCli(installEnv()).catch((err) =>
      console.warn('[agent] could not refresh the ftpb shim:', err)
    )
  }

  ipcMain.handle('agent:getClientSetups', async (): Promise<IpcResult<AgentClientSetup[]>> => {
    try {
      const env = installEnv()
      const endpoint = getEndpoint()
      const { exe, cli } = prepareCliRuntime(env)
      const setups = buildClientSetups({
        url: endpoint?.url ?? `http://127.0.0.1:${MCP_PORT}/mcp`,
        token: endpoint?.token,
        ftpbCommand: await ftpbCommand(env),
        ftpbExec: { command: exe, args: [cli], env: { ELECTRON_RUN_AS_NODE: '1' } },
        tokenFile: tokenFilePath(app.getPath('userData')),
        home: env.home
      })
      return { success: true, data: setups }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('agent:getCliStatus', async (): Promise<IpcResult<CliInstallStatus>> => {
    try {
      return { success: true, data: await getCliStatus(installEnv()) }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('agent:installCli', async (): Promise<IpcResult<CliInstallStatus>> => {
    try {
      return { success: true, data: await installCli(installEnv()) }
    } catch (err) {
      return ipcError(err)
    }
  })

  ipcMain.handle('agent:installSkill', async (): Promise<IpcResult<{ paths: string[] }>> => {
    try {
      const env = installEnv()
      const markdown = buildSkillMarkdown({ ftpbCommand: await ftpbCommand(env) })
      return { success: true, data: { paths: installSkill(env.home, markdown) } }
    } catch (err) {
      return ipcError(err)
    }
  })
}
