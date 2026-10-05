import { vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { isImageFile } from '@shared/constants'
import { DEFAULT_AGENT_POLICY, type AgentPolicy } from '@shared/types/agent'
import type { FtpFileEntry } from '@shared/types/ftp'
import type { LocalFileEntry } from '@shared/types/local'
import type { OperationJob } from '@shared/types/operation'
import type { TransferJob } from '@shared/types/transfer'
import {
  AgentError,
  type AgentServices,
  type DeletePlan,
  type DownloadPlan,
  type JobSnapshot,
  type SavedServerInfo,
  type ServerRef,
  type SessionInfo,
  type UploadPlan
} from '../../agent/types'
import { JobHandles } from '../jobHandles'
import { createMcpToolServer, type McpToolDeps } from '../mcpTools'
import { ActionLock } from '../toolRegistry'

/** makeDeps의 에이전트 폴더(§9 R2). 가짜 세계의 로컬 경로가 모두 이 안에 있다. */
export const FAKE_LOCAL_ROOT = '/home/u'

/** A saved password the fakes leak on purpose (like a sloppy row spread) to prove no tool echoes it. */
export const SECRET_PASSWORD = 'hunter2-SECRET-pw'

export function remoteFile(name: string, size = 100): FtpFileEntry {
  return {
    name,
    type: 'file',
    size,
    modifiedAt: '2026-01-02T03:04:05.000Z',
    rawModifiedAt: 'Jan 02 03:04',
    isImage: isImageFile(name)
  }
}

export function remoteDir(name: string): FtpFileEntry {
  return { name, type: 'directory', size: 0, modifiedAt: '', rawModifiedAt: '', isImage: false }
}

export function localFile(dir: string, name: string, size = 10): LocalFileEntry {
  return {
    name,
    path: `${dir}/${name}`,
    type: 'file',
    size,
    modifiedAt: '2026-01-02T03:04:05.000Z',
    isImage: isImageFile(name)
  }
}

export interface FakeWorld {
  session: SessionInfo
  servers: SavedServerInfo[]
  /** Remote listings by path; other paths fail like an FTP 550. */
  listings: Record<string, FtpFileEntry[]>
  localListings: Record<string, LocalFileEntry[]>
  transfers: TransferJob[]
  operations: OperationJob[]
  snapshots: Record<string, JobSnapshot>
  downloadPlan?: DownloadPlan
  uploadPlan?: UploadPlan
  deletePlan?: DeletePlan
}

function withPassword(server: SavedServerInfo): SavedServerInfo {
  // 구현이 DB 행을 통째로 펼친 것처럼 비밀번호를 숨겨 둔다.
  return Object.assign({ ...server }, { password: SECRET_PASSWORD })
}

function ftp550(): Error {
  return Object.assign(new Error('550 No such file or directory'), { code: 550 })
}

function unknownJob(id: string): JobSnapshot {
  return { id, kind: 'transfer', status: 'unknown', done: true, name: id }
}

export function defaultWorld(): FakeWorld {
  return {
    session: {
      status: 'connected',
      serverId: 1,
      host: 'ftp.example.com',
      port: 2121,
      user: 'alice'
    },
    servers: [
      {
        id: 1,
        name: 'Photos',
        host: 'ftp.example.com',
        port: 2121,
        user: 'alice',
        secure: false,
        maxTransfers: 4
      },
      {
        id: 2,
        name: '',
        host: 'backup.example.org',
        port: 21,
        user: 'bob',
        secure: true,
        maxTransfers: 2
      }
    ],
    listings: { '/': [remoteDir('photos'), remoteFile('a.jpg')], '/photos': [remoteFile('b.png')] },
    localListings: { '/home/u': [localFile('/home/u', 'x.txt')] },
    transfers: [],
    operations: [],
    snapshots: {}
  }
}

/** Every AgentServices method is a vi.fn over a small in-memory world. */
export function fakeServices(world: FakeWorld = defaultWorld()): AgentServices {
  const resolve = (ref: ServerRef): SavedServerInfo => {
    const found = world.servers.find((s) =>
      typeof ref === 'number'
        ? s.id === ref
        : s.name.toLowerCase() === ref.toLowerCase() || s.host.toLowerCase() === ref.toLowerCase()
    )
    if (!found) {
      throw new AgentError(
        'NOT_FOUND',
        `No saved server "${ref}". Saved: Photos, backup.example.org`
      )
    }
    return withPassword(found)
  }
  const planDelete = async (paths: string[]): Promise<DeletePlan> =>
    world.deletePlan ?? {
      targets: paths.map((path) => ({
        path,
        kind: world.listings[path] || world.localListings[path] ? 'directory' : 'file'
      })),
      totalFiles: paths.length,
      totalDirectories: 0
    }
  const get = (ids: string[]): JobSnapshot[] =>
    ids.map((id) => world.snapshots[id] ?? unknownJob(id))
  // FtpConnectionManager의 연결 번호처럼 connect·disconnect마다 바뀐다
  let generation = 0
  return {
    session: {
      info: vi.fn(() => world.session),
      key: vi.fn(() =>
        world.session.status === 'connected'
          ? JSON.stringify([generation, world.session.host, world.session.port, world.session.user])
          : undefined
      ),
      connect: vi.fn(async (ref: ServerRef, path?: string) => {
        const server = resolve(ref)
        generation++
        world.session = {
          status: 'connected',
          serverId: server.id,
          host: server.host,
          port: server.port,
          user: server.user
        }
        return { path: path ?? '/last' }
      }),
      disconnect: vi.fn(async () => {
        generation++
        world.session = { status: 'disconnected' }
      })
    },
    servers: {
      list: vi.fn(() => world.servers.map(withPassword)),
      resolve: vi.fn(resolve),
      remove: vi.fn()
    },
    remote: {
      list: vi.fn(async (path: string) => {
        const entries = world.listings[path]
        if (!entries) throw ftp550()
        return { path, entries }
      }),
      mkdir: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      planDelete: vi.fn(planDelete),
      startDelete: vi.fn(() => 'op-remote')
    },
    local: {
      list: vi.fn(async (path: string) => {
        const entries = world.localListings[path]
        if (!entries) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
        return { path, entries }
      }),
      mkdir: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      planDelete: vi.fn(planDelete),
      startDelete: vi.fn(() => 'op-local')
    },
    transfers: {
      planDownload: vi.fn(
        async (remotePaths: string[], localDir: string): Promise<DownloadPlan> =>
          world.downloadPlan ?? {
            items: remotePaths.map((remotePath) => ({
              remotePath,
              localPath: `${localDir}/${remotePath.split('/').pop()}`,
              size: 100
            })),
            createDirs: [],
            skipped: [],
            totalBytes: remotePaths.length * 100
          }
      ),
      startDownload: vi.fn((plan: DownloadPlan) => plan.items.map((_, i) => `dl-${i}`)),
      planUpload: vi.fn(
        async (localPaths: string[], remoteDir: string): Promise<UploadPlan> =>
          world.uploadPlan ?? {
            items: localPaths.map((localPath) => ({
              localPath,
              remotePath: `${remoteDir}/${localPath.split('/').pop()}`,
              size: 10,
              overwrites: false
            })),
            remoteDirs: [],
            skipped: [],
            totalBytes: localPaths.length * 10
          }
      ),
      startUpload: vi.fn((plan: UploadPlan) => plan.items.map((_, i) => `ul-${i}`)),
      list: vi.fn(() => world.transfers)
    },
    jobs: {
      get: vi.fn(get),
      wait: vi.fn(async (ids: string[]) => get(ids)),
      cancel: vi.fn((ids: string[] | 'all') => (ids === 'all' ? 3 : ids.length)),
      clearFinished: vi.fn()
    }
  }
}

export interface TestDeps extends McpToolDeps {
  /** Mutable: the next request's McpServer reads it. */
  currentPolicy: AgentPolicy
  confirm: ReturnType<typeof vi.fn<McpToolDeps['confirm']>>
  notify: {
    activity: ReturnType<typeof vi.fn<McpToolDeps['notify']['activity']>>
    openServerEditor: ReturnType<typeof vi.fn<McpToolDeps['notify']['openServerEditor']>>
  }
}

export function makeDeps(
  services: AgentServices = fakeServices(),
  overrides: Partial<Omit<McpToolDeps, 'operations'>> & { operations?: OperationJob[] } = {}
): TestDeps {
  const { operations = [], ...rest } = overrides
  const deps: TestDeps = {
    version: '0.0.0-test',
    services,
    operations: { getAll: () => operations },
    currentPolicy: { ...DEFAULT_AGENT_POLICY },
    policy: { get: () => deps.currentPolicy },
    confirm: vi.fn<McpToolDeps['confirm']>(async () => 'approved'),
    notify: {
      activity: vi.fn<McpToolDeps['notify']['activity']>(),
      openServerEditor: vi.fn<McpToolDeps['notify']['openServerEditor']>(() => true)
    },
    previews: vi.fn(async (requests) =>
      requests.map(() => ({ ok: true as const, data: 'AAAA', width: 40, height: 30 }))
    ),
    jobHandles: new JobHandles(),
    actionLock: new ActionLock(),
    localRoot: FAKE_LOCAL_ROOT,
    ...rest
  } as unknown as TestDeps
  return deps
}

export const ALLOW_ALL: AgentPolicy = { W: 'allow', D: 'allow', X: 'allow', C: 'allow' }

/**
 * 포트 없이 같은 프로세스에서 SDK 클라이언트로 도구를 부른다. `modern`은 2026-07-28 프로토콜로 협상한다.
 * `userAgent`는 모든 HTTP 요청에 User-Agent 헤더로 붙는다.
 */
export async function connectClient(
  deps: McpToolDeps,
  options: { name?: string; modern?: boolean; userAgent?: string } = {}
): Promise<Client> {
  const handler = createMcpHandler(() => createMcpToolServer(deps))
  const client = new Client(
    { name: options.name ?? 'test-client', version: '1.0.0' },
    options.modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined
  )
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
      ...(options.userAgent
        ? { requestInit: { headers: { 'User-Agent': options.userAgent } } }
        : {})
    })
  )
  return client
}

export type CallResult = Awaited<ReturnType<Client['callTool']>>

export function textOf(result: CallResult): string {
  const first = result.content[0]
  return first?.type === 'text' ? first.text : ''
}
