import type { ConnectionStatus, FtpListResult } from '@shared/types/ftp'
import type { LocalListResult } from '@shared/types/local'
import type { TransferJob } from '@shared/types/transfer'

/**
 * Contract between the agent services (src/main/agent/services/*) and the MCP tool layer
 * (src/main/mcp/*). See docs/handoff/agent-operations.md §5. Services hold the app logic and
 * know nothing about MCP, risk tiers or confirmation; tools validate input, apply the policy and
 * shape results.
 */

/** A saved server, referred to by id or by its alias / host (case-insensitive). */
export type ServerRef = number | string

/** A saved server as agents see it. There is no password field, by design (M11). */
export interface SavedServerInfo {
  id: number
  name: string
  host: string
  port: number
  user: string
  secure: boolean
  maxTransfers: number
  lastConnected?: string
}

export interface SessionInfo {
  status: ConnectionStatus
  serverId?: number
  host?: string
  port?: number
  user?: string
}

/** download: never overwrite. 'skip' leaves existing local files; 'rename' picks "name (1).ext". */
export type DownloadConflict = 'skip' | 'rename'
/** upload: 'skip' leaves existing remote files; 'overwrite' replaces them (the plan says which). */
export type UploadConflict = 'skip' | 'overwrite'

export interface DeletePlan {
  /**
   * Top-level targets as given (absolute paths), with their kind. Directories carry `entries`: the
   * files and folders inside, counted recursively by the same walk as the totals (spec §10 U4).
   */
  targets: Array<{ path: string; kind: 'file' | 'directory'; entries?: number }>
  /** Every file and folder that will be removed, counted recursively. */
  totalFiles: number
  totalDirectories: number
  /**
   * Remote plans only: `session.key()` when the plan was made. The delete stops before the next
   * target once the session differs (spec §9 R1).
   */
  session?: string
}

export interface DownloadPlan {
  items: Array<{ remotePath: string; localPath: string; size: number }>
  /** Local folders to create first (folder downloads), parents before children. */
  createDirs: string[]
  /** Entries left out: existing file with conflict 'skip', unusable name, symlink, … */
  skipped: Array<{ remotePath: string; reason: string }>
  totalBytes: number
}

export interface UploadPlan {
  items: Array<{ localPath: string; remotePath: string; size: number; overwrites: boolean }>
  /** Remote folders to create first (folder uploads), parents before children. */
  remoteDirs: string[]
  skipped: Array<{ localPath: string; reason: string }>
  totalBytes: number
}

/** A transfer or a file operation (delete), seen through one shape so agents can wait on both. */
export interface JobSnapshot {
  id: string
  kind: 'transfer' | 'operation'
  /** TransferStatus or OperationStatus. */
  status: string
  /** completed, failed or cancelled — nothing more will happen to it. */
  done: boolean
  name: string
  transferredBytes?: number
  totalBytes?: number
  completed?: number
  total?: number
  error?: string
}

export type AgentErrorCode =
  | 'NOT_CONNECTED'
  | 'NOT_FOUND'
  | 'TARGET_EXISTS'
  | 'INVALID_PATH'
  | 'BUSY'
  | 'TOO_MANY_ITEMS'
  | 'SESSION_CHANGED'
  | 'NOT_A_FILE'

/**
 * A failure the agent can act on. Services throw this for conditions they detect themselves;
 * FTP / file-system errors pass through unchanged and the tool layer classifies them
 * (classifyError).
 */
export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AgentError'
  }
}

/** Upper bound of files one plan may contain (download / upload / delete). */
export const MAX_PLAN_ITEMS = 10_000

export interface AgentServices {
  session: {
    info(): SessionInfo
    /**
     * Identifies the current FTP session (host, port, user and a connection number that changes
     * on every connect and disconnect, also to the same server). undefined while not connected.
     */
    key(): string | undefined
    /**
     * Connect the app (and its GUI) to a saved server, then open `path` or, like the GUI, the
     * folder last visited on that server, falling back to '/'. Throws AgentError BUSY while
     * transfers or file operations are active, NOT_FOUND for an unknown server.
     */
    connect(ref: ServerRef, path?: string): Promise<{ path: string }>
    /** Throws AgentError BUSY while transfers or file operations are active (spec §9 R8). */
    disconnect(): Promise<void>
  }
  servers: {
    list(): SavedServerInfo[]
    /** Throws AgentError NOT_FOUND, listing the saved names in the message. */
    resolve(ref: ServerRef): SavedServerInfo
    /** Also removes the server's recent paths, like the GUI. */
    remove(id: number): void
  }
  remote: {
    list(path: string): Promise<FtpListResult>
    mkdir(path: string): Promise<void>
    /** Rename or move. Throws AgentError TARGET_EXISTS if `to` exists (no clobber). */
    rename(from: string, to: string): Promise<void>
    planDelete(paths: string[]): Promise<DeletePlan>
    /** Runs as an OperationManager job (visible in the GUI); returns its id at once. */
    startDelete(plan: DeletePlan): string
    /**
     * The first `maxBytes` of a remote file, read into memory (spec §10 U5). `truncated` says the
     * file is longer; `size` is exact unless truncated, then the size the server lists. Throws
     * AgentError NOT_FOUND for a missing path, NOT_A_FILE for a folder, and BUSY when no second
     * FTP connection opens and the file is larger than `maxBytes`.
     */
    readFile(
      path: string,
      maxBytes: number
    ): Promise<{ size: number; data: Buffer; truncated: boolean }>
  }
  local: {
    list(path: string): Promise<LocalListResult>
    mkdir(path: string): Promise<void>
    /** Same folder only, no clobber (LocalFileSystem.rename rules). */
    rename(from: string, to: string): Promise<void>
    planDelete(paths: string[]): Promise<DeletePlan>
    startDelete(plan: DeletePlan): string
  }
  transfers: {
    /** Remote folders are walked recursively; names pass through toLocalFileName. */
    planDownload(
      remotePaths: string[],
      localDir: string,
      conflict: DownloadConflict
    ): Promise<DownloadPlan>
    /** Creates `createDirs`, enqueues one batch in the shared queue; returns the job ids. */
    startDownload(plan: DownloadPlan): string[]
    /** Local folders are expanded recursively like a drag-and-drop upload. */
    planUpload(
      localPaths: string[],
      remoteDir: string,
      conflict: UploadConflict
    ): Promise<UploadPlan>
    startUpload(plan: UploadPlan): string[]
    list(): TransferJob[]
  }
  jobs: {
    /** Unknown ids are returned with status 'unknown' and done: true. */
    get(ids: string[]): JobSnapshot[]
    /** Resolves when every id is done or after `timeoutMs`, whichever comes first. */
    wait(ids: string[], timeoutMs: number): Promise<JobSnapshot[]>
    /** Returns how many jobs it cancelled. */
    cancel(ids: string[] | 'all'): number
    clearFinished(): void
  }
}
