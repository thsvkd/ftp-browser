import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { posix } from 'path'
import Database from 'better-sqlite3'
import { vi } from 'vitest'
import { OperationManager } from '../../../operation/OperationManager'
import type {
  ConnectionStatus,
  FtpConnectPayload,
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
import type { DeleteProgressCallback } from '../../../ftp/FtpFileOperations'
import type { AgentServiceDeps } from '../index'

/** servers.test.ts와 같은 실제 스키마(마이그레이션 + initDatabase가 덧붙이는 테이블). */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  const migrations = path.join(__dirname, '../../../db/migrations')
  db.exec(fs.readFileSync(path.join(migrations, '001_initial.sql'), 'utf-8'))
  db.exec(fs.readFileSync(path.join(migrations, '002_server_max_transfers.sql'), 'utf-8'))
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

type Node = { type: FtpFileEntry['type']; size: number }

/** 550을 흉내 낸 FTP 에러 (basic-ftp FTPError처럼 숫자 code) */
function ftpError(message: string): Error {
  return Object.assign(new Error(message), { code: 550 })
}

/**
 * 메모리 위 원격 트리. FtpConnectionManager(list/connect…)와 FtpFileOperations(mkdir/rename/delete…)
 * 자리에 들어간다. 목 FTP 서버에는 LIST·MKD·DELE·RNFR이 없어 서비스 테스트는 이것을 쓴다.
 */
export class FakeRemote extends EventEmitter {
  nodes = new Map<string, Node>([['/', { type: 'directory', size: 0 }]])
  connected = true
  status: ConnectionStatus = 'connected'
  host = 'nas.local'
  port = 21
  user = 'me'
  /** list가 실패할 경로 */
  failList = new Set<string>()
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
    const key = dir.length > 1 ? dir.replace(/\/+$/, '') : dir
    if (this.failList.has(key) || this.nodes.get(key)?.type !== 'directory') {
      throw ftpError(`550 ${key}: No such directory`)
    }
    const entries: FtpFileEntry[] = []
    for (const [p, node] of this.nodes) {
      if (p !== '/' && posix.dirname(p) === key) {
        entries.push({
          name: posix.basename(p),
          type: node.type,
          size: node.size,
          modifiedAt: '',
          rawModifiedAt: '',
          isImage: false
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
  addFile(p: string, size = 1): this {
    this.nodes.set(p, { type: 'file', size })
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
  // forceBatch·remoteDirs 인자는 mock.calls로 확인한다
  enqueueBatch = vi.fn((direction: TransferDirection, items: TransferEnqueueItem[]): string[] => {
    const added = items.map((item) => ({
      id: randomUUID(),
      direction,
      ...item,
      transferredBytes: 0,
      status: 'pending' as TransferStatus
    }))
    this.jobs.push(...added)
    return added.map((job) => job.id)
  })
  cancel = vi.fn((id: string): void => {
    const job = this.jobs.find((j) => j.id === id)
    if (job && (job.status === 'pending' || job.status === 'active')) job.status = 'cancelled'
  })
  clearCompleted = vi.fn((): void => {
    const removed = this.jobs.filter((j) => j.status !== 'pending' && j.status !== 'active')
    this.jobs = this.jobs.filter((j) => j.status === 'pending' || j.status === 'active')
    this.emitUpdate([], removed)
  })
  getAll = (): TransferJob[] => [...this.jobs]

  add(fields: Partial<TransferJob> = {}): TransferJob {
    const job: TransferJob = {
      id: randomUUID(),
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
  finish(id: string, status: TransferStatus): void {
    const job = this.jobs.find((j) => j.id === id)!
    job.status = status
    this.emitUpdate([job], [])
  }
  private emitUpdate(upserts: TransferJob[], removed: TransferJob[]): void {
    const update: TransferUpdate = {
      upserts: upserts.map((j) => ({ ...j })),
      removedIds: removed.map((j) => j.id)
    }
    this.emit('queue:updated', update)
  }
}

export interface Harness {
  deps: AgentServiceDeps
  db: Database.Database
  remote: FakeRemote
  queue: FakeQueue
  operations: OperationManager
  events: { localChanged: ReturnType<typeof vi.fn>; session: ReturnType<typeof vi.fn> }
}

/** 서비스 deps를 가짜로 채운다. localFs는 테스트가 실제 LocalFileSystem을 넣는다. */
export function createHarness(overrides: Partial<AgentServiceDeps> = {}): Harness {
  const db = createTestDb()
  const remote = new FakeRemote()
  const queue = new FakeQueue()
  const operations = new OperationManager()
  const events = { localChanged: vi.fn(), session: vi.fn() }
  const deps: AgentServiceDeps = {
    db,
    ftp: remote,
    fileOps: remote,
    queue,
    operations,
    localFs: {
      list: vi.fn(),
      mkdir: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(),
      collectFiles: vi.fn()
    },
    events,
    platform: 'linux',
    ...overrides
  }
  return { deps, db, remote, queue, operations, events }
}
