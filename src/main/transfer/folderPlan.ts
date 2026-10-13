import { readdir, stat } from 'fs/promises'
import path, { posix } from 'path'
import { toLocalFileName, uniqueLocalNames } from '@shared/entryName'
import type { FtpFileEntry } from '@shared/types/ftp'
import type {
  ConflictDecision,
  TransferConflict,
  TransferDirection,
  TransferEnqueueItem
} from '@shared/types/transfer'
import { AgentError } from '../mcp/agentOps'

/** 계획이 쓰는 앱 서비스. GUI(transfer:send)와 에이전트(agentOps)가 같은 계획을 쓴다. */
export interface PlanDeps {
  list(dir: string): Promise<{ entries: FtpFileEntry[] }>
  collectFiles(
    dir: string
  ): Promise<Array<{ abs: string; rel: string; size: number; modifiedAt: string }>>
  /** 로컬 파일 이름 규칙(toLocalFileName)과 로컬 이름의 대소문자 구분 */
  platform: string
}

/** 큐에 넣을 전송과 건너뛴 항목. dirs는 먼저 만들 폴더다(다운로드는 로컬, 업로드는 원격). */
export interface TransferPlan {
  items: TransferEnqueueItem[]
  dirs: string[]
  skipped: Array<{ path: string; reason: string }>
  totalBytes: number
  /** 업로드만: 원격 파일을 바꾸는 항목 수 */
  overwrites: number
}

/** 대상에 같은 이름의 파일이 있는 항목. 결정을 받아야 큐에 넣는다(D9·D10). */
export type PlannedConflict = TransferConflict & {
  item: TransferEnqueueItem
  /** 이름 바꾸기의 새 이름. 대상 폴더에 있는 이름과 이 계획이 그 폴더에 넣는 이름을 모두 피한다. */
  renameTo: string
  /** 건너뛰면 plan.skipped의 이 자리에 넣는다. 사유 목록이 발견 순서 그대로 남는다. */
  skipAt: number
}

export interface FolderPlan extends TransferPlan {
  /** 충돌 대상이 로컬(download)인지 원격(upload)인지. 경로 문자열로는 가릴 수 없다(같은 경로로 배포하는 업로드) */
  direction: TransferDirection
  conflicts: PlannedConflict[]
}

interface RemoteItem {
  remotePath: string
  entry: FtpFileEntry
}

const newPlan = (direction: TransferDirection): FolderPlan => ({
  direction,
  items: [],
  dirs: [],
  skipped: [],
  totalBytes: 0,
  overwrites: 0,
  conflicts: []
})

/** '.'·'..'를 뺀 폴더 내용 */
async function children(deps: Pick<PlanDeps, 'list'>, dir: string): Promise<RemoteItem[]> {
  const { entries } = await deps.list(dir)
  return entries
    .filter((e) => e.name !== '.' && e.name !== '..')
    .map((entry) => ({ remotePath: posix.join(dir, entry.name), entry }))
}

/**
 * 경로마다 부모 폴더 목록에서 항목을 찾는다(파일을 직접 LIST하는 방식은 서버마다 다르다). 같은 부모는 한
 * 번만 읽는다. `required`면 하나라도 없을 때 NOT_FOUND이고, 아니면 없는 경로를 뺀다.
 */
export async function findRemote(
  deps: Pick<PlanDeps, 'list'>,
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
export function outermost(paths: string[], sep = '/'): string[] {
  const unique = [...new Set(paths)]
  const inside = (p: string, o: string): boolean => p.startsWith(o.endsWith(sep) ? o : o + sep)
  return unique.filter((p) => !unique.some((o) => o !== p && inside(p, o)))
}

/** `name`의 비어 있는 `이름 (n).확장자`. occupied의 이름을 모두 피한다(uniqueLocalNames와 같은 번호 규칙). */
function freeName(name: string, occupied: string[], platform: string): string {
  return uniqueLocalNames([...new Set(occupied), name], platform).at(-1)!
}

/**
 * 원격 파일·폴더(재귀)를 로컬 폴더에 놓을 계획. 이름은 toLocalFileName으로 고치고, 같은 이름의 로컬 폴더에는
 * 합쳐 받는다. 로컬에 있는 파일은 충돌이다. 디스크는 읽기만 한다: 새 폴더(dirs)는 호출자가 큐에 넣기 직전에 만든다.
 */
export async function planDownload(
  deps: PlanDeps,
  remotePaths: string[],
  localDir: string
): Promise<FolderPlan> {
  const { platform } = deps
  // Windows·macOS 파일 시스템은 기본으로 대소문자를 가리지 않는다(uniqueLocalNames와 같다)
  const key = (p: string): string =>
    platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p
  const plan = newPlan('download')

  /** 원격 항목들을 로컬 폴더 `dir`에 놓는다. `isNew`면 아직 없는(이 계획이 만들) 폴더다. */
  const place = async (dir: string, isNew: boolean, items: RemoteItem[]): Promise<void> => {
    const existing = new Map<string, boolean>() // 이름 → 폴더인지
    const occupied: string[] = []
    for (const d of isNew ? [] : await readdir(dir, { withFileTypes: true })) {
      existing.set(key(d.name), d.isDirectory())
      occupied.push(d.name)
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
    const conflicts: PlannedConflict[] = []
    for (const [i, { remotePath, entry }] of usable.entries()) {
      const target = path.join(dir, names[i])
      // true: 로컬 폴더, false: 로컬 파일, undefined: 비어 있다
      const taken = existing.get(key(names[i]))
      if (taken === undefined) occupied.push(names[i])
      const item = { remotePath, localPath: target, fileName: entry.name, totalBytes: entry.size }
      if (entry.type === 'directory' && taken !== false) {
        if (taken === undefined) plan.dirs.push(target)
        await place(target, taken === undefined, await children(deps, remotePath))
      } else if (entry.type !== 'directory' && taken === false) {
        const local = await stat(target)
        const conflict: PlannedConflict = {
          target,
          source: remotePath,
          name: names[i],
          incoming: { size: entry.size, modifiedAt: entry.modifiedAt },
          existing: { size: local.size, modifiedAt: local.mtime.toISOString() },
          item,
          renameTo: '',
          skipAt: plan.skipped.length
        }
        // 발견 순서대로 넣는다(skipAt이 늘어나는 순서). 새 이름은 이 폴더의 이름을 다 모은 뒤 정한다.
        plan.conflicts.push(conflict)
        conflicts.push(conflict)
      } else if (taken !== undefined) {
        plan.skipped.push({ path: remotePath, reason: 'already exists in the local folder' })
      } else {
        plan.items.push(item)
        plan.totalBytes += item.totalBytes
      }
    }
    for (const conflict of conflicts) {
      conflict.renameTo = freeName(conflict.name, occupied, platform)
      occupied.push(conflict.renameTo)
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
  return plan
}

/** 원격 폴더에 놓을 파일 하나. `localPath`는 출처(업로드면 로컬 경로, 서버 간 전송이면 보내는 쪽 원격 경로)다. */
interface IncomingFile {
  localPath: string
  /** 대상 폴더 아래 상대 경로('/' 구분) */
  rel: string
  size: number
  modifiedAt: string
}

/**
 * 로컬 파일·폴더(재귀)를 원격 폴더에 올릴 계획. drag-and-drop 업로드처럼 펼치고, 사이 폴더(dirs)는 큐가 만든다.
 * 원격에 있는 파일은 충돌이다. 빈 로컬 폴더는 올리지 않는다(D31).
 */
export async function planUpload(
  deps: PlanDeps,
  localPaths: string[],
  remoteDir: string
): Promise<FolderPlan> {
  const files: IncomingFile[] = []
  for (const p of outermost(localPaths, path.sep)) {
    const st = await stat(p).catch((err: NodeJS.ErrnoException) => {
      throw err.code === 'ENOENT' ? new AgentError('NOT_FOUND', `Not found: ${p}`) : err
    })
    const name = path.basename(p)
    if (!st.isDirectory()) {
      files.push({ localPath: p, rel: name, size: st.size, modifiedAt: st.mtime.toISOString() })
    }
    for (const f of st.isDirectory() ? await deps.collectFiles(p) : []) {
      const rel = `${name}/${f.rel.split(path.sep).join('/')}`
      files.push({ localPath: f.abs, rel, size: f.size, modifiedAt: f.modifiedAt })
    }
  }
  return planIntoRemote(deps, files, remoteDir)
}

/**
 * 보내는 쪽 원격 파일·폴더(재귀)를 받는 쪽 원격 폴더에 놓을 계획(서버 간 전송, MC23). 보내는 쪽은 `src.list`로만
 * 펼치고(심볼릭 링크는 건너뛴다, 빈 폴더는 만들지 않는다), 받는 쪽 확인은 업로드와 같다(`planIntoRemote`).
 * 항목의 `localPath` 자리에 보내는 쪽 경로가 든다.
 */
export async function planRelay(
  src: Pick<PlanDeps, 'list'>,
  dst: Pick<PlanDeps, 'list'>,
  remotePaths: string[],
  remoteDir: string
): Promise<FolderPlan> {
  const plan = newPlan('relay')
  const files: IncomingFile[] = []
  const collect = async (items: RemoteItem[], prefix: string): Promise<void> => {
    for (const { remotePath, entry } of items) {
      const rel = prefix + entry.name
      if (entry.type === 'symbolic-link') {
        plan.skipped.push({ path: remotePath, reason: 'symbolic link' })
      } else if (entry.type === 'directory') {
        await collect(await children(src, remotePath), `${rel}/`)
      } else {
        files.push({ localPath: remotePath, rel, size: entry.size, modifiedAt: entry.modifiedAt })
      }
    }
  }
  // 루트에는 이름이 없다: 그 내용을 remoteDir에 바로 놓는다(planDownload와 같다)
  const sources = outermost(remotePaths)
  await collect(sources[0] === '/' ? await children(src, '/') : await findRemote(src, sources), '')
  return planIntoRemote(dst, files, remoteDir, plan)
}

/**
 * 파일들을 원격 폴더 `remoteDir` 아래 `rel` 자리에 놓을 계획(업로드·서버 간 전송이 함께 쓴다). 원격에 있는 파일은
 * 충돌이고, 같은 이름 폴더·폴더 자리의 파일·같은 대상 경로 중복은 건너뛴다. `plan`이 있으면 거기에 이어 쓴다.
 */
async function planIntoRemote(
  deps: Pick<PlanDeps, 'list'>,
  files: IncomingFile[],
  remoteDir: string,
  plan: FolderPlan = newPlan('upload')
): Promise<FolderPlan> {
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

  const seen = new Set<string>()
  for (const { localPath, rel, size, modifiedAt } of files) {
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
            : undefined
    if (reason) {
      plan.skipped.push({ path: localPath, reason })
      continue
    }
    const fileName = posix.basename(remotePath)
    const item = { localPath, remotePath, fileName, totalBytes: size }
    if (entry) {
      plan.conflicts.push({
        target: remotePath,
        source: localPath,
        name: fileName,
        incoming: { size, modifiedAt },
        existing: { size: entry.size, modifiedAt: entry.modifiedAt },
        item,
        renameTo: '',
        skipAt: plan.skipped.length
      })
      continue
    }
    plan.items.push(item)
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

  // 새 이름은 서버 폴더의 이름, 이 계획이 그 폴더에 넣는 파일·폴더, 앞서 정한 새 이름을 피한다.
  // 서버 이름은 대소문자를 구분한다(그래서 'linux' 규칙).
  // ponytail: 충돌마다 계획 전체를 훑는 O(충돌×항목). 수만 개 충돌이 흔해지면 폴더별 이름 집합으로 바꾼다.
  const entering = [...plan.items.map((i) => i.remotePath), ...plan.dirs]
  for (const conflict of plan.conflicts) {
    const dir = posix.dirname(conflict.target)
    const here = entering.filter((p) => posix.dirname(p) === dir).map((p) => posix.basename(p))
    const names = [...(await folder(dir))!.keys(), ...here]
    conflict.renameTo = freeName(conflict.name, names, 'linux')
    entering.push(posix.join(dir, conflict.renameTo))
  }
  return plan
}

/** 순수 함수. 결정을 적용해 넣을 항목·건너뛴 항목과, 결정이 없는 충돌을 나눈다. */
export function resolvePlan(
  plan: FolderPlan,
  decide: (conflict: PlannedConflict) => ConflictDecision | undefined
): {
  items: TransferEnqueueItem[]
  skipped: TransferPlan['skipped']
  unresolved: TransferConflict[]
  overwrites: number
  totalBytes: number
} {
  const items = [...plan.items]
  const skipped = [...plan.skipped]
  const unresolved: TransferConflict[] = []
  let overwrites = 0
  let inserted = 0
  for (const c of plan.conflicts) {
    const { item, renameTo, skipAt, ...conflict } = c
    const download = plan.direction === 'download'
    const decision = decide(c)
    // 어느 한쪽 시각을 읽을 수 없으면 NaN이라 늦지 않다(건너뜀)
    const newer = Date.parse(c.incoming.modifiedAt) > Date.parse(c.existing.modifiedAt)
    if (decision === 'overwrite' || (decision === 'newer' && newer)) {
      items.push(item)
      overwrites++
    } else if (decision === 'rename') {
      items.push(
        download
          ? { ...item, localPath: path.join(path.dirname(c.target), renameTo) }
          : {
              ...item,
              remotePath: posix.join(posix.dirname(c.target), renameTo),
              fileName: renameTo
            }
      )
    } else if (decision === 'skip' || decision === 'newer') {
      const reason = download
        ? 'already exists in the local folder'
        : 'already exists on the server'
      skipped.splice(skipAt + inserted++, 0, { path: c.source, reason })
    } else {
      unresolved.push(conflict)
    }
  }
  const totalBytes = items.reduce((sum, i) => sum + i.totalBytes, 0)
  return { items, skipped, unresolved, overwrites, totalBytes }
}
