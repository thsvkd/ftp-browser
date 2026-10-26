import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path, { posix } from 'path'
import Database from 'better-sqlite3'
import { vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { isImageFile } from '@shared/constants'
import { connKey, parseConnKey, type ConnKey } from '@shared/connKey'
import type {
  ConnectionStatus,
  FtpConnectPayload,
  FtpConnectionState,
  FtpFileEntry,
  FtpListResult
} from '@shared/types/ftp'
import type {
  TransferDirection,
  TransferEnqueueItem,
  TransferJob,
  TransferStatus,
  TransferUpdate
} from '@shared/types/transfer'
import { OperationManager } from '../../operation/OperationManager'
import { createPasswordVault } from '../../db/passwordVault'
import { FakeCipher } from '../../db/__fixtures__/fakeCipher'
import type { DeleteProgressCallback } from '../../ftp/FtpFileOperations'
import { createJobTracker } from '../jobTracker'
import { createMcpToolServer, type McpToolDeps } from '../mcpTools'

/** servers.test.ts와 같은 실제 스키마(마이그레이션 + initDatabase가 덧붙이는 테이블). */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  const migrations = path.join(__dirname, '../../db/migrations')
  for (const file of fs.readdirSync(migrations).sort()) {
    db.exec(fs.readFileSync(path.join(migrations, file), 'utf-8'))
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_host_port ON servers(host, port)')
  db.exec(`CREATE TABLE IF NOT EXISTS server_recent_paths (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_host TEXT NOT NULL,
    server_port INTEGER NOT NULL,
    path TEXT NOT NULL,
    last_visited TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(server_host, server_port, path)
  )`)
  return db
}

type Node = { type: FtpFileEntry['type']; size: number; modifiedAt?: string }

/** 550을 흉내 낸 FTP 에러 (basic-ftp FTPError처럼 숫자 code) */
function ftpError(message: string): Error {
  return Object.assign(new Error(message), { code: 550 })
}

/**
 * 메모리 위 원격 트리. FtpConnectionManager(list/connect…)와 FtpFileOperations(mkdir/rename/delete…)
 * 자리에 들어간다. 목 FTP 서버에는 LIST·MKD·DELE·RNFR이 없어 도구 테스트는 이것을 쓴다.
 */
/** FakeRemote의 기본 연결 키(`user@host:port`). FakeQueue가 작업의 `server`로 쓴다. */
const FAKE_SERVER = connKey('nas.local', 21, 'me')

export class FakeRemote extends EventEmitter {
  nodes = new Map<string, Node>([['/', { type: 'directory', size: 0 }]])
  connected = true
  status: ConnectionStatus = 'connected'
  host = 'nas.local'
  port = 21
  user = 'me'
  /** MKD를 조용히 무시하는 서버(ensureRemoteDir가 음수 응답을 삼킨다) */
  ignoreMkd = false
  connectResult: { success: boolean; error?: string; cancelled?: boolean } = { success: true }

  connect = vi.fn(async (config: FtpConnectPayload) => {
    if (!this.connectResult.success) return this.connectResult
    this.connected = true
    this.status = 'connected'
    this.host = config.host
    this.port = config.port
    this.user = config.user
    return this.connectResult
  })
  disconnect = vi.fn(async () => {
    this.connected = false
    this.status = 'disconnected'
  })
  list = vi.fn(async (dir: string): Promise<FtpListResult> => {
    if (!this.connected) throw new Error('Not connected')
    if (this.nodes.get(dir)?.type !== 'directory') throw ftpError(`550 ${dir}: No such directory`)
    const entries: FtpFileEntry[] = []
    for (const [p, node] of this.nodes) {
      if (p !== '/' && posix.dirname(p) === dir) {
        const name = posix.basename(p)
        entries.push({
          name,
          type: node.type,
          size: node.size,
          modifiedAt: node.modifiedAt ?? '',
          rawModifiedAt: '',
          isImage: node.type === 'file' && isImageFile(name)
        })
      }
    }
    return { path: dir, entries }
  })
  isConnected = (): boolean => this.connected
  getStatus = (): ConnectionStatus => this.status
  getHost = (): string => this.host
  getPort = (): number => this.port
  getUser = (): string => this.user
  getConnKey = (): string => connKey(this.host, this.port, this.user)
  /** 연결이 끊긴 상태로 둔다(`disconnect` 호출 기록은 남기지 않는다) */
  setOffline(): this {
    this.connected = false
    this.status = 'disconnected'
    return this
  }

  mkdir = vi.fn(async (dir: string) => {
    if (!this.ignoreMkd) {
      let current = ''
      for (const part of dir.split('/').filter(Boolean)) {
        current += `/${part}`
        if (!this.nodes.has(current)) this.nodes.set(current, { type: 'directory', size: 0 })
      }
    }
    this.emit('mutation', { kind: 'mkdir', remotePath: dir })
  })
  rename = vi.fn(async (from: string, to: string) => {
    if (!this.nodes.has(from)) throw ftpError(`550 ${from}`)
    for (const [p, node] of [...this.nodes]) {
      if (p === from || p.startsWith(`${from}/`)) {
        this.nodes.delete(p)
        this.nodes.set(to + p.slice(from.length), node)
      }
    }
    this.emit('mutation', { kind: 'rename', remotePath: from, newPath: to })
  })
  deleteFile = vi.fn(async (p: string) => {
    if (!this.nodes.delete(p)) throw ftpError(`550 ${p}`)
    this.emit('mutation', { kind: 'delete', remotePath: p })
  })
  deleteEmptyDirectory = vi.fn(async (dir: string) => {
    if ([...this.nodes.keys()].some((p) => p.startsWith(`${dir}/`)))
      throw ftpError(`550 ${dir}: Directory not empty`)
    if (!this.nodes.delete(dir)) throw ftpError(`550 ${dir}`)
    this.emit('mutation', { kind: 'delete', remotePath: dir })
  })
  deleteDirectory = vi.fn(async (dir: string, onProgress?: DeleteProgressCallback) => {
    const doomed = [...this.nodes.keys()].filter((p) => p === dir || p.startsWith(`${dir}/`))
    doomed.sort((a, b) => b.length - a.length)
    doomed.forEach((p, i) => {
      this.nodes.delete(p)
      onProgress?.(i + 1, doomed.length, p)
    })
    this.emit('mutation', { kind: 'delete', remotePath: dir })
  })

  addDir(p: string): this {
    this.nodes.set(p, { type: 'directory', size: 0 })
    return this
  }
  addFile(p: string, size = 1, modifiedAt?: string): this {
    this.nodes.set(p, { type: 'file', size, modifiedAt })
    return this
  }
  addLink(p: string): this {
    this.nodes.set(p, { type: 'symbolic-link', size: 0 })
    return this
  }
}

/** TransferQueue의 공개 API만 흉내 낸다. 상태는 finish로 바꾸고 queue:updated를 낸다. */
export class FakeQueue extends EventEmitter {
  jobs: TransferJob[] = []

  /** 작업의 `server`. 실제 큐처럼 생성자 옵션으로 받는다. */
  constructor(private server: ConnKey = FAKE_SERVER) {
    super()
  }

  // 실제 큐처럼 여러 항목이거나 forceBatch면 묶음 id를 붙인다. remoteDirs·options는 mock.calls로 본다.
  enqueueBatch = vi.fn(
    (direction: TransferDirection, items: TransferEnqueueItem[], forceBatch = false): string[] => {
      const batchId = items.length > 1 || forceBatch ? randomUUID() : undefined
      const added = items.map((item) => ({
        id: randomUUID(),
        batchId,
        server: this.server,
        direction,
        ...item,
        transferredBytes: 0,
        status: 'pending' as TransferStatus
      }))
      this.jobs.push(...added)
      return added.map((job) => job.id)
    }
  )
  getAll = (): TransferJob[] => [...this.jobs]

  add(fields: Partial<TransferJob> = {}): TransferJob {
    const job: TransferJob = {
      id: randomUUID(),
      server: this.server,
      direction: 'download',
      localPath: '/tmp/x',
      remotePath: '/x',
      fileName: 'x',
      totalBytes: 1,
      transferredBytes: 0,
      status: 'pending',
      ...fields
    }
    this.jobs.push(job)
    return job
  }
  finish(id: string, status: TransferStatus, error?: string): void {
    const job = this.jobs.find((j) => j.id === id)!
    job.status = status
    if (error !== undefined) job.error = error
    this.emit('queue:updated', { upserts: [{ ...job }], removedIds: [] } satisfies TransferUpdate)
  }
  /** 사용자가 끝난 전송을 목록에서 지운다 */
  clearCompleted(): void {
    const removed = this.jobs.filter((j) => j.status !== 'pending' && j.status !== 'active')
    this.jobs = this.jobs.filter((j) => j.status === 'pending' || j.status === 'active')
    this.emit('queue:updated', { upserts: [], removedIds: removed.map((j) => j.id) })
  }
}

/** 세션 큐들을 이어 붙여 보이는 TransferHub 가짜. 큐들의 `queue:updated`를 다시 낸다. */
export class FakeHub extends EventEmitter {
  private queues: FakeQueue[] = []

  add(queue: FakeQueue): void {
    this.queues.push(queue)
    queue.on('queue:updated', (update: TransferUpdate) => this.emit('queue:updated', update))
  }
  getAll = (): TransferJob[] => this.queues.flatMap((queue) => queue.getAll())
}

/**
 * ConnectionRegistry 가짜. 키마다 `FakeRemote`(매니저·파일 작업) 하나와 `FakeQueue` 하나가 세션이다.
 * `connect`는 그 키의 세션을 만들고(처음엔 끊김) 늘 그 `FakeRemote.connect`로 로그인한다. 이미 연결된
 * 세션에 다시 로그인하지 않는 것은 실제 레지스트리와 agentOps가 한다.
 */
export class FakeConnections {
  remotes = new Map<ConnKey, FakeRemote>()
  queues = new Map<ConnKey, FakeQueue>()

  constructor(private hub: FakeHub) {}

  connect = vi.fn(async (payload: FtpConnectPayload) => {
    const key = connKey(payload.host, payload.port, payload.user)
    if (!this.remotes.has(key)) this.add(key).setOffline()
    return { server: key, ...(await this.remotes.get(key)!.connect(payload)) }
  })
  disconnect = vi.fn(async (key: ConnKey) => {
    await this.remotes.get(key)?.disconnect()
  })

  get(
    key: ConnKey
  ): { key: ConnKey; manager: FakeRemote; fileOps: FakeRemote; queue: FakeQueue } | undefined {
    const remote = this.remotes.get(key)
    return remote && { key, manager: remote, fileOps: remote, queue: this.queues.get(key)! }
  }
  connectedKeys(): ConnKey[] {
    return [...this.remotes].filter(([, remote]) => remote.isConnected()).map(([key]) => key)
  }
  states(): FtpConnectionState[] {
    return [...this.remotes].map(([server, remote]) => {
      const { host, port, user } = parseConnKey(server)!
      return { server, status: remote.getStatus(), host, port, user }
    })
  }

  /** 연결된 세션 하나를 더한다(키의 host·port·user를 갖는다). */
  add(key: ConnKey): FakeRemote {
    const { host, port, user } = parseConnKey(key)!
    const remote = new FakeRemote()
    Object.assign(remote, { host, port, user })
    const queue = new FakeQueue(key)
    this.remotes.set(key, remote)
    this.queues.set(key, queue)
    this.hub.add(queue)
    return remote
  }
}

export interface Harness {
  deps: McpToolDeps
  db: Database.Database
  /** 기본 세션(`me@nas.local:21`, 연결됨)의 원격과 큐 */
  remote: FakeRemote
  queue: FakeQueue
  connections: FakeConnections
  hub: FakeHub
  operations: OperationManager
  sessions: ReturnType<typeof vi.fn>
}

/**
 * 도구 deps를 가짜 연결·큐와 실제 OperationManager·DB·비밀번호 금고로 채운다. 기본은 연결된 세션
 * 하나(multi-connection 규칙 ③으로 인자 없는 도구가 그 연결을 쓴다). 세션은 `connections.add`로 더한다.
 */
export function createHarness(overrides: Partial<McpToolDeps> = {}): Harness {
  const db = createTestDb()
  const hub = new FakeHub()
  const connections = new FakeConnections(hub)
  const remote = connections.add(FAKE_SERVER)
  const queue = connections.queues.get(FAKE_SERVER)!
  const operations = new OperationManager()
  const sessions = vi.fn()
  const deps: McpToolDeps = {
    version: '0.0.0-test',
    db,
    connections,
    transfers: hub,
    target: {},
    operations,
    localFs: { collectFiles: vi.fn(async () => []) },
    passwords: createPasswordVault(db, new FakeCipher()),
    onSession: sessions,
    previews: vi.fn(async (_conn: ConnKey, requests) =>
      requests.map(() => ({ ok: true as const, data: 'AAAA', width: 40, height: 30 }))
    ),
    jobs: createJobTracker(hub, operations),
    platform: 'linux',
    ...overrides
  }
  return { deps, db, remote, queue, connections, hub, operations, sessions }
}

/** 저장된 서버 하나를 넣고 id를 돌려준다. 비밀번호는 평문 열에 둔다(금고가 그대로 읽는다). */
export function addServer(
  db: Database.Database,
  fields: Partial<{ name: string; host: string; port: number; user: string; password: string }> = {}
): number {
  const s = { name: '', host: 'nas.local', port: 21, user: 'me', password: 'pw', ...fields }
  return Number(
    db
      .prepare(
        'INSERT INTO servers (name, host, port, username, password_enc, secure) VALUES (?, ?, ?, ?, ?, 0)'
      )
      .run(s.name, s.host, s.port, s.user, s.password).lastInsertRowid
  )
}

/** 포트 없이 같은 프로세스에서 SDK 클라이언트로 도구를 부른다. */
export async function connectClient(deps: McpToolDeps): Promise<Client> {
  const handler = createMcpHandler(() => createMcpToolServer(deps))
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init))
    })
  )
  return client
}

export type CallResult = Awaited<ReturnType<Client['callTool']>>

export function textOf(result: CallResult): string {
  const first = result.content[0]
  return first?.type === 'text' ? first.text : ''
}

/** 도구 하나를 부르고 결과를 돌려준다. */
export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<CallResult> {
  return client.callTool({ name, arguments: args })
}

/** 성공한 결과의 structuredContent */
export function dataOf<T = Record<string, unknown>>(result: CallResult): T {
  if (result.isError) throw new Error(`tool failed: ${textOf(result)}`)
  return result.structuredContent as T
}
