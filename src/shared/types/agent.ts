import type { ConnectionStatus } from './ftp'

/**
 * Risk tier of an agent tool (docs/handoff/agent-operations.md §2.2).
 * R read · W reversible write · D destructive · X exfiltration (upload) · C credentials/config.
 */
export type RiskTier = 'R' | 'W' | 'D' | 'X' | 'C'

/** What the app does when an agent calls a tool of a tier. R is always allowed. */
export type PolicyValue = 'allow' | 'ask' | 'deny'

export type PolicyTier = Exclude<RiskTier, 'R'>

export type AgentPolicy = Record<PolicyTier, PolicyValue>

export const DEFAULT_AGENT_POLICY: AgentPolicy = { W: 'allow', D: 'ask', X: 'ask', C: 'ask' }

/** One entry the confirmation dialog lists. Names come from the remote server: render as text only. */
export interface AgentPlanItem {
  path: string
  kind: 'file' | 'directory'
  size?: number
  /** The action replaces an existing file (upload with conflict 'overwrite'). */
  overwrites?: boolean
}

/** Main → renderer: ask the user to approve one agent tool call. */
export interface AgentConfirmRequest {
  id: string
  /** Tool name, e.g. 'delete'. The renderer localizes its title as `agent.tool.<tool>`. */
  tool: string
  tier: RiskTier
  /** MCP clientInfo.name when the client sent one (e.g. 'claude-code'). Untrusted text. */
  client?: string
  /** FTP host the action targets, when it targets the remote side. */
  host?: string
  /** At most 20 items; `totalItems` counts all of them. */
  items: AgentPlanItem[]
  totalItems: number
  totalBytes?: number
  /** ISO time after which main answers 'timeout' by itself. */
  expiresAt: string
}

/** Main → renderer: a non-R tool ran (or was refused); shown as a toast. */
export interface AgentActivity {
  tool: string
  tier: RiskTier
  outcome: 'done' | 'started' | 'denied' | 'failed'
  totalItems?: number
}

/** Main → renderer: the agent changed the FTP session (connect / disconnect). */
export interface AgentSessionEvent {
  status: ConnectionStatus
  serverId?: number
  host?: string
  port?: number
  user?: string
  /** Remote folder the session opened, for the GUI to navigate to. */
  path?: string
}

/** Main → renderer: local files changed through an agent tool; refresh if one is visible. */
export interface LocalChangeEvent {
  /** Absolute local paths that changed (the parent folder is what needs refreshing). */
  paths: string[]
}

/** Main → renderer: open the server editor pre-filled; the user types the password and saves. */
export interface ServerEditorRequest {
  name?: string
  host: string
  port: number
  user: string
  secure: boolean
}

/** How one agent client is registered with the app (Settings › Connect an agent, `ftpb setup`). */
export interface AgentClientSetup {
  id: string
  title: string
  /** http: Streamable HTTP + header · stdio: `ftpb mcp-stdio` bridge · cli: `ftpb` + skill. */
  kind: 'http' | 'stdio' | 'cli'
  /** Ready-to-paste command or config. May contain the token. */
  snippet: string
  /** Where the snippet goes (file path / command), one short paragraph. */
  notes: string
  docsUrl: string
}

export interface CliInstallStatus {
  installed: boolean
  /** Path of the installed `ftpb` shim (or where it would be installed). */
  path: string
  /** Whether that folder is on the user's PATH. */
  onPath: boolean
  /** Shell line the user can run to put it on PATH, when it is not. */
  pathHint?: string
  error?: string
}
