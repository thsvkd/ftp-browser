import type { ConnKey } from '../connKey'
import type { ConnectionStatus } from './ftp'

/** 설정 대화상자가 읽는 내장 MCP 서버 상태 */
export interface McpState {
  enabled: boolean
  /** 서버가 실제로 listen 중인지. 켜져 있어도 listen에 실패하면 false다. */
  running: boolean
  /** 엔드포인트 URL (`http://127.0.0.1:47821/mcp`) */
  url: string
  /** Claude Code 등록 명령. 토큰을 담으므로 화면에 표시하지 않고 복사에만 쓴다. 토큰이 아직 없으면 없다. */
  command?: string
  /** Codex `~/.codex/config.toml` 조각(토큰 포함, 복사에만 쓴다) */
  codexConfig?: string
  /** 다른 클라이언트용 `mcpServers` JSON(토큰 포함, 복사에만 쓴다) */
  jsonConfig?: string
  /** 앱에 든 `ftpb` CLI를 실행하는 명령(토큰 없음). 에이전트가 뒤에 `tools` 같은 인자를 붙인다. */
  cliCommand?: string
  /** listen 실패 사유(예: 포트 사용 중) */
  error?: string
}

/** Main → renderer (`agent:session`): an agent connected or disconnected the app's FTP session. */
export interface AgentSessionEvent {
  /** The connection the agent connected or disconnected. */
  server: ConnKey
  status: ConnectionStatus
  serverId?: number
  host?: string
  port?: number
  user?: string
  /** Remote folder the session opened, for the GUI to navigate to. */
  path?: string
}

/** Main → renderer (`agent:activity`): what agents are doing through MCP right now. */
export interface AgentActivityEvent {
  /** A tool call is running, or a transfer or delete an agent started is still pending or active. */
  active: boolean
  /** Stop was pressed but a transfer it could not cancel is still running (main-connection fallback). */
  stopping?: boolean
  /** The agent's name when it is known (`Claude Code`, `Codex`, `ftpb`…). */
  client?: string
  /** The tool of the last call that started. */
  tool?: string
  /** What that call acts on (a path, `from → to`, a server). Untrusted text. */
  target?: string
  /** The user pressed stop: hide the indicator at once. */
  stopped?: boolean
}
