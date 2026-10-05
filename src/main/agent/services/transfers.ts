import { lstatSync, mkdirSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import path, { posix } from 'path'
import { toLocalFileName, uniqueLocalNames } from '@shared/entryName'
import type { FtpFileEntry } from '@shared/types/ftp'
import type { TransferJob } from '@shared/types/transfer'
import {
  AgentError,
  MAX_PLAN_ITEMS,
  type AgentServices,
  type DownloadPlan,
  type UploadPlan
} from '../types'
import { checkLocalPath, checkRemotePath, outermost, tooManyItems } from './paths'
import { listChildren, requireConnected, statRemote } from './remote'
import type { AgentServiceDeps } from './index'

interface RemoteItem {
  remotePath: string
  entry: FtpFileEntry
}

const isRunning = (job: TransferJob): boolean => job.status === 'pending' || job.status === 'active'

/** 경로에 무엇이든(끊긴 심링크 포함) 있는지. 확인할 수 없으면 있다고 본다. */
function occupied(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

export function createTransfersService(
  deps: Pick<AgentServiceDeps, 'ftp' | 'queue' | 'localFs' | 'events' | 'platform'>
): AgentServices['transfers'] {
  const { ftp, queue, localFs, events } = deps
  const platform = deps.platform ?? process.platform
  // Windows·macOS 파일 시스템은 기본으로 대소문자를 가리지 않는다(uniqueLocalNames와 같다)
  const ignoreCase = platform === 'win32' || platform === 'darwin'
  const key = (p: string): string => (ignoreCase ? p.toLowerCase() : p)

  /** 받는 중이거나 받을 차례인 로컬 경로. 이미 있는 파일과 같이 피한다. */
  const downloadTargets = (): Set<string> =>
    new Set(
      queue
        .getAll()
        .filter((job) => job.direction === 'download' && isRunning(job))
        .map((job) => key(job.localPath))
    )

  const children = async (dir: string): Promise<RemoteItem[]> =>
    (await listChildren(ftp, dir)).map((entry) => ({
      remotePath: posix.join(dir, entry.name),
      entry
    }))

  return {
    // T5: 다운로드는 'w'로 열고 취소·실패하면 그 경로를 지운다. 그래서 계획은 이미 있는 파일을 절대 대상으로
    // 삼지 않는다: 'skip'은 빼고 'rename'은 비어 있는 이름을 고른다. 같은 이름의 폴더에는 합쳐 받는다.
    planDownload: async (remotePaths, localDir, conflict) => {
      const sources = outermost(remotePaths.map(checkRemotePath), '/')
      const dest = checkLocalPath(localDir)
      requireConnected(ftp)
      const plan: DownloadPlan = { items: [], createDirs: [], skipped: [], totalBytes: 0 }
      const inFlight = downloadTargets()

      const freeName = (name: string, dir: string, taken: Set<string>): string => {
        // uniqueLocalNames와 같은 모양: 확장자 앞에 번호, 앞의 점은 확장자가 아니다
        const dot = name.lastIndexOf('.')
        const stem = dot > 0 ? name.slice(0, dot) : name
        const ext = dot > 0 ? name.slice(dot) : ''
        for (let n = 1; ; n++) {
          const candidate = `${stem} (${n})${ext}`
          if (!taken.has(key(candidate)) && !inFlight.has(key(path.join(dir, candidate)))) {
            taken.add(key(candidate))
            return candidate
          }
        }
      }

      /** 원격 항목들을 로컬 폴더 `dir`에 놓는다. `isNew`면 아직 없는(계획이 만들) 폴더다. */
      const place = async (dir: string, isNew: boolean, items: RemoteItem[]): Promise<void> => {
        const existing = new Map<string, boolean>() // 이름 → 폴더인지
        if (!isNew) {
          for (const dirent of await readdir(dir, { withFileTypes: true })) {
            existing.set(key(dirent.name), dirent.isDirectory())
          }
        }
        const usable: Array<RemoteItem & { name: string }> = []
        for (const item of items) {
          const name =
            item.entry.type === 'symbolic-link' ? null : toLocalFileName(item.entry.name, platform)
          if (name !== null) usable.push({ ...item, name })
          else {
            const reason =
              item.entry.type === 'symbolic-link'
                ? 'symbolic link'
                : 'the name cannot be used on this computer'
            plan.skipped.push({ remotePath: item.remotePath, reason })
          }
        }
        // 고친 이름끼리 겹치면 GUI(planDownloads)처럼 뒤의 것에 번호를 붙인다
        const names = uniqueLocalNames(
          usable.map((u) => u.name),
          platform
        )
        const taken = new Set([...existing.keys(), ...names.map(key)])
        for (let i = 0; i < usable.length; i++) {
          const { remotePath, entry } = usable[i]
          let name = names[i]
          const clash = existing.has(key(name)) || inFlight.has(key(path.join(dir, name)))
          if (clash && entry.type === 'directory' && existing.get(key(name))) {
            await place(path.join(dir, name), false, await children(remotePath))
            continue
          }
          if (clash) {
            if (conflict === 'skip') {
              plan.skipped.push({ remotePath, reason: 'already exists in the local folder' })
              continue
            }
            name = freeName(name, dir, taken)
          }
          const target = path.join(dir, name)
          if (entry.type === 'directory') {
            plan.createDirs.push(target)
            await place(target, true, await children(remotePath))
          } else {
            plan.items.push({ remotePath, localPath: target, size: entry.size })
            plan.totalBytes += entry.size
            if (plan.items.length > MAX_PLAN_ITEMS) throw tooManyItems()
          }
        }
      }

      const top: RemoteItem[] = []
      for (const { path: p, entry } of await statRemote(ftp, sources)) {
        // 루트에는 이름이 없다: 그 내용을 localDir에 바로 받는다
        if (p === '/') top.push(...(await children('/')))
        else top.push({ remotePath: p, entry })
      }
      const destStat = await stat(dest).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null
        throw err
      })
      if (destStat && !destStat.isDirectory()) {
        throw new AgentError('INVALID_PATH', `${dest} is not a folder.`)
      }
      if (!destStat) plan.createDirs.push(dest)
      await place(dest, !destStat, top)
      return plan
    },

    startDownload: (plan) => {
      requireConnected(ftp)
      for (const dir of plan.createDirs) mkdirSync(dir, { recursive: true })
      if (plan.createDirs.length > 0) events.localChanged({ paths: plan.createDirs })
      // 계획과 시작 사이(확인 대화상자 등)에 생긴 파일이나 다른 다운로드가 맡은 경로는 받지 않는다(T5)
      const inFlight = downloadTargets()
      const items = plan.items.filter(
        (item) => !inFlight.has(key(item.localPath)) && !occupied(item.localPath)
      )
      return queue.enqueueBatch(
        'download',
        items.map((item) => ({
          remotePath: item.remotePath,
          localPath: item.localPath,
          fileName: posix.basename(item.remotePath),
          totalBytes: item.size
        })),
        plan.createDirs.length > 0
      )
    },

    // T6: drag-and-drop 업로드(local:expandForUpload + remoteDrop)와 같이 펼친다. 덮어쓸 파일을 알아야
    // 하므로 대상 폴더와 그 아래 이미 있는 폴더를 읽는다. 읽지 못하면 그 에러로 멈춘다.
    planUpload: async (localPaths, remoteDir, conflict) => {
      const sources = outermost(localPaths.map(checkLocalPath), path.sep)
      const dest = checkRemotePath(remoteDir)
      requireConnected(ftp)

      const files: Array<{ localPath: string; rel: string; size: number }> = []
      for (const p of sources) {
        const st = await stat(p).catch((err: NodeJS.ErrnoException) => {
          throw err.code === 'ENOENT' ? new AgentError('NOT_FOUND', `Not found: ${p}`) : err
        })
        const name = path.basename(p)
        if (st.isDirectory()) {
          for (const f of await localFs.collectFiles(p)) {
            files.push({
              localPath: f.abs,
              rel: `${name}/${f.rel.split(path.sep).join('/')}`,
              size: f.size
            })
          }
        } else {
          files.push({ localPath: p, rel: name, size: st.size })
        }
        if (files.length > MAX_PLAN_ITEMS) throw tooManyItems()
      }

      // 원격 폴더: 있으면 그 내용(이름 → 항목), 없으면 'missing', 파일 등이 그 자리에 있으면 'blocked'
      type Folder = Map<string, FtpFileEntry> | 'missing' | 'blocked'
      const folders = new Map<string, Folder>()
      const read = async (dir: string): Promise<Folder> =>
        new Map((await listChildren(ftp, dir)).map((entry) => [entry.name, entry]))
      const folder = async (dir: string): Promise<Folder> => {
        let state = folders.get(dir)
        if (state) return state
        if (dir === dest) {
          state = await read(dir)
        } else {
          const parent = await folder(posix.dirname(dir))
          const entry = typeof parent === 'string' ? undefined : parent.get(posix.basename(dir))
          state =
            typeof parent === 'string'
              ? parent
              : !entry
                ? 'missing'
                : entry.type === 'directory'
                  ? await read(dir)
                  : 'blocked'
        }
        folders.set(dir, state)
        return state
      }

      const plan: UploadPlan = { items: [], remoteDirs: [], skipped: [], totalBytes: 0 }
      const dirSet = new Set<string>()
      /** 없는 폴더를 조상부터 remoteDirs에 넣는다. folder()가 조상의 상태를 이미 채워 두었다. */
      const addRemoteDirs = (dir: string): void => {
        const chain: string[] = []
        for (let d = dir; folders.get(d) === 'missing' && !dirSet.has(d); d = posix.dirname(d)) {
          chain.push(d)
        }
        for (const d of chain.reverse()) {
          dirSet.add(d)
          plan.remoteDirs.push(d)
        }
      }
      const seen = new Set<string>()
      for (const file of files) {
        const remotePath = posix.join(dest, file.rel)
        const skip = (reason: string): void => {
          plan.skipped.push({ localPath: file.localPath, reason })
        }
        if (/[\r\n\0]/.test(remotePath)) {
          skip('the name cannot be used on the server')
          continue
        }
        if (seen.has(remotePath)) {
          skip('another file in this upload has the same remote path')
          continue
        }
        seen.add(remotePath)
        const parent = posix.dirname(remotePath)
        const state = await folder(parent)
        if (state === 'blocked') {
          skip('a file on the server is where its folder would go')
          continue
        }
        let overwrites = false
        if (state === 'missing') {
          addRemoteDirs(parent)
        } else {
          const existing = state.get(posix.basename(remotePath))
          if (existing?.type === 'directory') {
            skip('a folder with that name exists on the server')
            continue
          }
          if (existing && conflict === 'skip') {
            skip('already exists on the server')
            continue
          }
          overwrites = existing !== undefined
        }
        plan.items.push({ localPath: file.localPath, remotePath, size: file.size, overwrites })
        plan.totalBytes += file.size
      }
      return plan
    },

    startUpload: (plan) => {
      requireConnected(ftp)
      return queue.enqueueBatch(
        'upload',
        plan.items.map((item) => ({
          localPath: item.localPath,
          remotePath: item.remotePath,
          fileName: posix.basename(item.remotePath),
          totalBytes: item.size
        })),
        plan.remoteDirs.length > 0,
        plan.remoteDirs
      )
    },

    list: () => queue.getAll()
  }
}
