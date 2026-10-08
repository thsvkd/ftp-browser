import { mkdirSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import path, { posix } from 'path'
import type Database from 'better-sqlite3'
import { toLocalFileName, uniqueLocalNames } from '@shared/entryName'
import type { AgentSessionEvent } from '@shared/types/mcp'
import type { FtpFileEntry, FtpServer } from '@shared/types/ftp'
import type { TransferEnqueueItem } from '@shared/types/transfer'
import { getRecentPaths, KEEP_PASSWORD, listServers, recordConnection } from '../db/servers'
import type { PasswordVault } from '../db/passwordVault'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import type { FtpFileOperations } from '../ftp/FtpFileOperations'
import type { LocalFileSystem } from '../local/LocalFileSystem'
import type { OperationManager } from '../operation/OperationManager'
import type { TransferQueue } from '../transfer/TransferQueue'

/** 에이전트 도구가 쓰는 앱 서비스. GUI와 같은 인스턴스이고, 테스트는 가짜를 넣는다. */
export interface AgentDeps {
  db: Database.Database
  ftp: Pick<FtpConnectionManager, 'connect' | 'disconnect' | 'list' | 'isConnected'> &
    Pick<FtpConnectionManager, 'getStatus' | 'getHost' | 'getPort' | 'getUser'>
  fileOps: Pick<FtpFileOperations, 'mkdir' | 'rename' | 'deleteFile' | 'deleteDirectory'>
  queue: Pick<TransferQueue, 'enqueueBatch' | 'getAll'>
  operations: Pick<OperationManager, 'create' | 'progress' | 'complete' | 'fail' | 'getAll'> &
    Pick<OperationManager, 'isCancelled' | 'markCancelled'>
  localFs: Pick<LocalFileSystem, 'collectFiles'>
  /** 저장된 비밀번호는 연결할 때만 main 안에서 푼다(saved-password-encryption E13) */
  passwords: Pick<PasswordVault, 'reveal'>
  /** 에이전트가 연결·해제했다(`agent:session`). GUI가 그 서버와 폴더를 따라간다(K5). */
  onSession(event: AgentSessionEvent): void
  /** 로컬 파일 이름 규칙(toLocalFileName). 기본은 process.platform */
  platform?: string
}

/** 에이전트가 고칠 수 있는 실패(NOT_CONNECTED, NOT_FOUND, TARGET_EXISTS, INVALID_PATH, BUSY). */
export class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/** 큐에 넣은 전송과 건너뛴 항목. dirs는 먼저 만들 폴더다(다운로드는 로컬, 업로드는 원격). */
export interface TransferPlan {
  items: TransferEnqueueItem[]
  dirs: string[]
  skipped: Array<{ path: string; reason: string }>
  totalBytes: number
  /** 업로드만: 원격 파일을 바꾸는 항목 수 */
  overwrites: number
}

interface RemoteItem {
  remotePath: string
  entry: FtpFileEntry
}

const newPlan = (): TransferPlan => ({
  items: [],
  dirs: [],
  skipped: [],
  totalBytes: 0,
  overwrites: 0
})

// --- 저장된 서버와 연결 ---

/** 비밀번호 없이 필드를 하나씩 옮긴다. 행을 펼쳐(...) 복사하면 다른 필드가 따라 나간다. */
export function serverSummary(s: FtpServer): Record<string, unknown> {
  return { id: s.id, name: s.name, host: s.host, port: s.port, user: s.username, secure: s.secure }
}

/** id, 별칭, 호스트·`host:port` 순으로 찾는다(대소문자 무시). 숫자 문자열은 id로도 본다. */
function resolveServer(db: Database.Database, ref: number | string): FtpServer {
  const servers = listServers(db)
  const q = String(ref).trim().toLowerCase()
  const rules: Array<(s: FtpServer) => boolean> =
    typeof ref === 'number'
      ? [(s) => s.id === ref]
      : [
          (s) => s.name.toLowerCase() === q,
          (s) => s.host.toLowerCase() === q || `${s.host}:${s.port}`.toLowerCase() === q,
          (s) => /^\d+$/.test(q) && s.id === Number(q)
        ]
  const matches = rules.map((rule) => servers.filter(rule)).find((m) => m.length > 0) ?? []
  if (matches.length === 1) return matches[0]
  const saved = servers.map((s) => `${s.name || s.host} (id ${s.id}, ${s.host}:${s.port})`)
  const what =
    matches.length > 1
      ? `${JSON.stringify(ref)} matches ${matches.length} saved servers; use the id.`
      : `No saved server matches ${JSON.stringify(ref)}.`
  throw new AgentError('NOT_FOUND', `${what} Saved servers: ${saved.join(', ') || 'none'}.`)
}

/** 전송·파일 작업 중에 서버를 바꾸거나 끊으면 그 작업이 끊기거나 엉뚱한 서버로 간다(K4). */
function refuseIfBusy(deps: AgentDeps, action: string): void {
  const running = (s: string): boolean => s === 'pending' || s === 'active'
  if (
    deps.queue.getAll().some((job) => running(job.status)) ||
    deps.operations.getAll().some((op) => running(op.status))
  ) {
    throw new AgentError(
      'BUSY',
      `Transfers or file operations are still running. Wait for them to finish before ${action}.`
    )
  }
}

/**
 * GUI 연결 흐름처럼 저장된 서버에 연결하고 폴더(없으면 마지막으로 연 폴더, 열 수 없으면 `/`)를 연다.
 * 저장된 비밀번호는 main 안에서만 풀고, 그 행의 주소·계정으로만 보낸다.
 */
export async function connectSaved(
  deps: AgentDeps,
  ref: number | string,
  requested?: string
): Promise<{ server: FtpServer; path: string }> {
  refuseIfBusy(deps, 'connecting')
  const server = resolveServer(deps.db, ref)
  const { id, name, host, port, secure, maxTransfers } = server
  const user = server.username || 'anonymous'
  const password = (await deps.passwords.reveal(id!)) || 'anonymous@'
  const payload = { id, name, host, port, user, password, secure, maxTransfers }
  const result = await deps.ftp.connect(payload)
  if (!result.success) {
    throw new Error(
      result.cancelled ? 'Connection cancelled' : (result.error ?? 'Connection failed')
    )
  }
  try {
    // 저장된 비밀번호로 연결했으므로 그대로 두고 연결 시각만 찍는다
    recordConnection(deps.db, payload, KEEP_PASSWORD)
  } catch (err) {
    console.warn('[agent] Failed to persist server info:', err)
  }
  let opened = requested ?? getRecentPaths(deps.db, host, port)[0]?.path ?? '/'
  try {
    await deps.ftp.list(opened)
  } catch (err) {
    if (opened === '/') throw err
    await deps.ftp.list((opened = '/'))
  }
  deps.onSession({ status: 'connected', serverId: id, host, port, user, path: opened })
  return { server, path: opened }
}

export async function disconnect(deps: AgentDeps): Promise<void> {
  refuseIfBusy(deps, 'disconnecting')
  await deps.ftp.disconnect()
  deps.onSession({ status: 'disconnected' })
}

// --- 원격 파일 ---

export function requireConnected(deps: AgentDeps): void {
  if (!deps.ftp.isConnected()) {
    throw new AgentError('NOT_CONNECTED', 'FTP Browser is not connected to an FTP server.')
  }
}

/** '.'·'..'를 뺀 폴더 내용 */
async function children(deps: AgentDeps, dir: string): Promise<RemoteItem[]> {
  const { entries } = await deps.ftp.list(dir)
  return entries
    .filter((e) => e.name !== '.' && e.name !== '..')
    .map((entry) => ({ remotePath: posix.join(dir, entry.name), entry }))
}

/**
 * 경로마다 부모 폴더 목록에서 항목을 찾는다(파일을 직접 LIST하는 방식은 서버마다 다르다). 같은 부모는 한
 * 번만 읽는다. `required`면 하나라도 없을 때 NOT_FOUND이고, 아니면 없는 경로를 뺀다.
 */
async function findRemote(
  deps: AgentDeps,
  paths: string[],
  required = true
): Promise<RemoteItem[]> {
  const parents = new Map<string, RemoteItem[]>()
  const found: RemoteItem[] = []
  for (const p of paths) {
    const parent = posix.dirname(p)
    if (!parents.has(parent)) parents.set(parent, await children(deps, parent))
    const item = parents.get(parent)!.find((i) => i.remotePath === p)
    if (item) found.push(item)
    else if (required) throw new AgentError('NOT_FOUND', `Not found on the server: ${p}`)
  }
  return found
}

/** 다른 대상 폴더 안에 든 대상과 중복을 뺀다. 같은 항목을 두 번 지우거나 받지 않는다. */
function outermost(paths: string[], sep = '/'): string[] {
  const unique = [...new Set(paths)]
  const inside = (p: string, o: string): boolean => p.startsWith(o.endsWith(sep) ? o : o + sep)
  return unique.filter((p) => !unique.some((o) => o !== p && inside(p, o)))
}

export async function createDirectory(deps: AgentDeps, dir: string): Promise<void> {
  requireConnected(deps)
  await deps.fileOps.mkdir(dir)
  // ensureRemoteDir는 MKD의 음수 응답을 "이미 있음"으로 보고 삼킨다. 정말 폴더가 있는지 확인한다.
  const [made] = await findRemote(deps, [dir], false).catch(() => [])
  if (!made) throw new Error(`The server did not create ${dir}. Check that you may write there.`)
  if (made.entry.type !== 'directory') {
    throw new AgentError('TARGET_EXISTS', `${dir} already exists on the server as a file.`)
  }
}

/** 많은 서버가 RNTO로 대상을 덮어쓴다. RNFR을 보내기 전에 대상이 없는지 확인한다(K4). */
export async function renameRemote(deps: AgentDeps, from: string, to: string): Promise<void> {
  requireConnected(deps)
  if ((await findRemote(deps, [to], false)).length > 0) {
    throw new AgentError(
      'TARGET_EXISTS',
      `${to} already exists on the server; rename never overwrites.`
    )
  }
  await deps.fileOps.rename(from, to)
}

/**
 * 원격 파일·폴더를 OperationManager 작업으로 지우고(파일 작업 패널에 보인다) 작업 id를 바로 돌려준다.
 * 대상이 하나라도 없으면 아무것도 지우지 않는다. 진행률·취소는 ftp:deleteBatch와 같다.
 */
export async function startDelete(deps: AgentDeps, paths: string[]): Promise<string> {
  if (paths.includes('/'))
    throw new AgentError('INVALID_PATH', 'Refusing to delete the root folder.')
  requireConnected(deps)
  const targets = await findRemote(deps, outermost(paths))
  const { operations: ops, fileOps } = deps
  const itemName = targets.length === 1 ? posix.basename(targets[0].remotePath) : undefined
  const { id } = ops.create(
    'delete',
    { itemCount: targets.length, itemName },
    'files',
    targets.length
  )
  void (async () => {
    let done = 0
    try {
      for (const [i, { remotePath: p, entry }] of targets.entries()) {
        if (ops.isCancelled(id)) return ops.markCancelled(id)
        const rest = targets.length - i - 1
        if (entry.type === 'directory') {
          let removed = 0
          await fileOps.deleteDirectory(p, (n, total, item) => {
            removed = n
            ops.progress(id, done + n, posix.basename(item), done + total + rest)
          })
          done += removed
        } else {
          await fileOps.deleteFile(p)
          done++
        }
        ops.progress(id, done, posix.basename(p), done + rest)
      }
      ops.complete(id)
    } catch (err) {
      ops.fail(id, err instanceof Error ? err.message : String(err))
    }
  })()
  return id
}

// --- 전송 ---

/**
 * 원격 파일·폴더(재귀)를 로컬 폴더(없으면 만든다)로 받는다. 이름은 toLocalFileName으로 고치고, 이미 있는
 * 로컬 파일은 건너뛰며 같은 이름의 로컬 폴더에는 합쳐 받는다. 큐는 배타적 생성('wx')으로 열어, 그사이 그
 * 경로에 생긴 파일(다른 다운로드가 만든 것 포함)도 덮거나 지우지 않는다(K4).
 */
export async function download(
  deps: AgentDeps,
  remotePaths: string[],
  localDir: string
): Promise<{ ids: string[]; plan: TransferPlan }> {
  requireConnected(deps)
  const platform = deps.platform ?? process.platform
  // Windows·macOS 파일 시스템은 기본으로 대소문자를 가리지 않는다(uniqueLocalNames와 같다)
  const key = (p: string): string =>
    platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p
  const plan = newPlan()

  /** 원격 항목들을 로컬 폴더 `dir`에 놓는다. `isNew`면 아직 없는(이 호출이 만들) 폴더다. */
  const place = async (dir: string, isNew: boolean, items: RemoteItem[]): Promise<void> => {
    const existing = new Map<string, boolean>() // 이름 → 폴더인지
    for (const d of isNew ? [] : await readdir(dir, { withFileTypes: true })) {
      existing.set(key(d.name), d.isDirectory())
    }
    const usable: Array<RemoteItem & { name: string }> = []
    for (const item of items) {
      const link = item.entry.type === 'symbolic-link'
      const name = link ? null : toLocalFileName(item.entry.name, platform)
      if (name !== null) usable.push({ ...item, name })
      else {
        const reason = link ? 'symbolic link' : 'the name cannot be used on this computer'
        plan.skipped.push({ path: item.remotePath, reason })
      }
    }
    // 고친 이름끼리 겹치면 GUI처럼 뒤의 것에 번호를 붙인다
    const names = uniqueLocalNames(
      usable.map((u) => u.name),
      platform
    )
    for (const [i, { remotePath, entry }] of usable.entries()) {
      const target = path.join(dir, names[i])
      // true: 로컬 폴더, false: 로컬 파일, undefined: 비어 있다
      const taken = existing.get(key(names[i]))
      if (entry.type === 'directory' && taken !== false) {
        if (taken === undefined) plan.dirs.push(target)
        await place(target, taken === undefined, await children(deps, remotePath))
      } else if (taken !== undefined) {
        plan.skipped.push({ path: remotePath, reason: 'already exists in the local folder' })
      } else {
        const { name: fileName, size: totalBytes } = entry
        plan.items.push({ remotePath, localPath: target, fileName, totalBytes })
        plan.totalBytes += totalBytes
      }
    }
  }

  // 루트에는 이름이 없다: 그 내용을 localDir에 바로 받는다(outermost가 다른 경로를 뺀다)
  const sources = outermost(remotePaths)
  const top = sources[0] === '/' ? await children(deps, '/') : await findRemote(deps, sources)
  const dest = await stat(localDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw err
  })
  if (dest && !dest.isDirectory())
    throw new AgentError('INVALID_PATH', `${localDir} is not a folder.`)
  if (!dest) plan.dirs.push(localDir)
  await place(localDir, !dest, top)
  for (const dir of plan.dirs) mkdirSync(dir, { recursive: true })
  const options = { exclusive: true }
  const ids = deps.queue.enqueueBatch(
    'download',
    plan.items,
    plan.dirs.length > 0,
    undefined,
    options
  )
  return { ids, plan }
}

/**
 * 로컬 파일·폴더(재귀)를 원격 폴더로 올린다. drag-and-drop 업로드처럼 펼치고 사이 폴더는 큐가 만든다.
 * 원격에 있는 파일은 `overwrite`가 아니면 건너뛴다.
 */
export async function upload(
  deps: AgentDeps,
  localPaths: string[],
  remoteDir: string,
  overwrite: boolean
): Promise<{ ids: string[]; plan: TransferPlan }> {
  requireConnected(deps)
  const files: Array<{ localPath: string; rel: string; size: number }> = []
  for (const p of outermost(localPaths, path.sep)) {
    const st = await stat(p).catch((err: NodeJS.ErrnoException) => {
      throw err.code === 'ENOENT' ? new AgentError('NOT_FOUND', `Not found: ${p}`) : err
    })
    const name = path.basename(p)
    if (!st.isDirectory()) files.push({ localPath: p, rel: name, size: st.size })
    for (const f of st.isDirectory() ? await deps.localFs.collectFiles(p) : []) {
      const rel = `${name}/${f.rel.split(path.sep).join('/')}`
      files.push({ localPath: f.abs, rel, size: f.size })
    }
  }

  // 원격 폴더의 내용(이름 → 항목). 없는 폴더는 비어 있고, 파일 등이 그 자리에 있으면 null이다.
  // 있는 폴더만 읽는다: 읽지 못하면 덮어쓸지 알 수 없으므로 그 오류로 멈춘다.
  const folders = new Map<string, Promise<Map<string, FtpFileEntry> | null>>()
  const folder = (dir: string): Promise<Map<string, FtpFileEntry> | null> => {
    if (!folders.has(dir)) {
      const read = async (): Promise<Map<string, FtpFileEntry> | null> => {
        const entry =
          dir === remoteDir
            ? undefined
            : (await folder(posix.dirname(dir)))?.get(posix.basename(dir))
        if (dir !== remoteDir && entry?.type !== 'directory') return entry ? null : new Map()
        return new Map((await children(deps, dir)).map((i) => [i.entry.name, i.entry]))
      }
      folders.set(dir, read())
    }
    return folders.get(dir)!
  }

  const plan = newPlan()
  const seen = new Set<string>()
  for (const { localPath, rel, size } of files) {
    const remotePath = posix.join(remoteDir, rel)
    const unusable = /[\r\n\0]/.test(remotePath)
    const repeated = seen.has(remotePath)
    seen.add(remotePath)
    const existing = unusable || repeated ? undefined : await folder(posix.dirname(remotePath))
    const entry = existing?.get(posix.basename(remotePath))
    const reason = unusable
      ? 'the name cannot be used on the server'
      : repeated
        ? 'another file in this upload has the same remote path'
        : existing === null
          ? 'a file on the server is where its folder would go'
          : entry?.type === 'directory'
            ? 'a folder with that name exists on the server'
            : entry && !overwrite
              ? 'already exists on the server'
              : undefined
    if (reason) {
      plan.skipped.push({ path: localPath, reason })
      continue
    }
    if (entry) plan.overwrites++
    plan.items.push({
      localPath,
      remotePath,
      fileName: posix.basename(remotePath),
      totalBytes: size
    })
    plan.totalBytes += size
    // 대상 폴더 아래의 사이 폴더는 GUI 업로드처럼 큐가 만든다(있으면 MKD가 그냥 지나간다)
    for (
      let d = posix.dirname(remotePath);
      d !== remoteDir && !plan.dirs.includes(d);
      d = posix.dirname(d)
    ) {
      plan.dirs.push(d)
    }
  }
  const ids = deps.queue.enqueueBatch('upload', plan.items, plan.dirs.length > 0, plan.dirs)
  return { ids, plan }
}
