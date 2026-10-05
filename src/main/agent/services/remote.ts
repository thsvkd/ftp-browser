import { posix } from 'path'
import { Writable } from 'stream'
import { getParentRemotePath } from '../../utils/remotePath'
import type { FtpFileEntry } from '@shared/types/ftp'
import { AgentError, MAX_PLAN_ITEMS, type AgentServices, type DeletePlan } from '../types'
import { checkRemotePath, outermost, tooManyItems } from './paths'
import type { AgentServiceDeps } from './index'

type Ftp = AgentServiceDeps['ftp']

const ROOT: FtpFileEntry = {
  name: '',
  type: 'directory',
  size: 0,
  modifiedAt: '',
  rawModifiedAt: '',
  isImage: false
}

export function requireConnected(ftp: Ftp): void {
  if (!ftp.isConnected()) {
    throw new AgentError('NOT_CONNECTED', 'FTP Browser is not connected to an FTP server.')
  }
}

/**
 * §9 R1: 지금 FTP 세션을 가리키는 값. 같은 서버로 다시 연결해도 연결 번호가 바뀌므로 다른 값이다.
 * 연결이 없으면 undefined.
 */
export function sessionKey(ftp: Ftp): string | undefined {
  if (!ftp.isConnected()) return undefined
  return JSON.stringify([ftp.getConnectGeneration(), ftp.getHost(), ftp.getPort(), ftp.getUser()])
}

export const SESSION_CHANGED_MESSAGE =
  'SESSION_CHANGED: The FTP connection changed (another server, a reconnect or a disconnect), ' +
  'so the delete stopped before the next item.'

/** '.'·'..'를 뺀 폴더 내용 */
export async function listChildren(ftp: Ftp, dir: string): Promise<FtpFileEntry[]> {
  return (await ftp.list(dir)).entries.filter((e) => e.name !== '.' && e.name !== '..')
}

/**
 * 부모 폴더 목록에서 찾은 항목. 없으면 undefined, 부모를 읽지 못하면 그 에러다.
 * 파일을 직접 LIST하는 방식은 서버마다 달라 쓰지 않는다. `cache`는 한 계획 안에서 부모 목록을 재사용한다.
 */
export async function findRemote(
  ftp: Ftp,
  p: string,
  cache?: Map<string, FtpFileEntry[]>
): Promise<FtpFileEntry | undefined> {
  if (p === '/') return ROOT
  const parent = getParentRemotePath(p)
  let entries = cache?.get(parent)
  if (!entries) {
    entries = await listChildren(ftp, parent)
    cache?.set(parent, entries)
  }
  const name = posix.basename(p)
  return entries.find((e) => e.name === name)
}

/** 계획의 대상들. 하나라도 없으면 NOT_FOUND. */
export async function statRemote(
  ftp: Ftp,
  paths: string[]
): Promise<Array<{ path: string; entry: FtpFileEntry }>> {
  const cache = new Map<string, FtpFileEntry[]>()
  const out: Array<{ path: string; entry: FtpFileEntry }> = []
  for (const p of paths) {
    const entry = await findRemote(ftp, p, cache)
    if (!entry) throw new AgentError('NOT_FOUND', `Not found on the server: ${p}`)
    out.push({ path: p, entry })
  }
  return out
}

/**
 * readFile이 받는 쪽. 앞에서부터 `keep` 바이트만 남긴다. `stop`이면 다 모은 순간 오류로 받기를 끊는다
 * (basic-ftp는 pipeline 오류로 그 다운로드를 끝낸다). 메인 연결은 끊으면 늦게 온 응답이 다음 작업에
 * 섞이므로 `stop` 없이 끝까지 받고 나머지는 버린다.
 */
function headSink(keep: number, stop: boolean): { stream: Writable; head(): Buffer } {
  const chunks: Buffer[] = []
  let length = 0
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      if (length < keep) {
        const part = chunk.subarray(0, keep - length)
        chunks.push(part)
        length += part.length
      }
      callback(stop && length >= keep ? new Error('Read limit reached.') : null)
    }
  })
  return { stream, head: () => Buffer.concat(chunks, length) }
}

export function createRemoteService(
  deps: Pick<AgentServiceDeps, 'ftp' | 'fileOps' | 'operations'>
): AgentServices['remote'] {
  const { ftp, fileOps, operations } = deps

  /**
   * ftp:deleteBatch와 같은 순서로 지운다(대상 사이에서만 취소 확인). 진행률 단위는 지운 파일+폴더 수다.
   * 각 대상 앞에서 세션이 계획 때와 같은지 본다(§9 R1). 재연결 뒤 새 서버에서 이어 지우지 않는다.
   */
  const runDelete = async (id: string, plan: DeletePlan): Promise<void> => {
    const planned = plan.totalFiles + plan.totalDirectories
    // 계획 뒤에 트리가 커졌으면 total을 늘린다
    const report = (completed: number, p: string): void =>
      operations.progress(id, completed, posix.basename(p), Math.max(planned, completed))
    let done = 0
    try {
      for (const target of plan.targets) {
        if (operations.isCancelled(id)) {
          operations.markCancelled(id)
          return
        }
        if (sessionKey(ftp) !== plan.session) {
          operations.fail(id, SESSION_CHANGED_MESSAGE)
          return
        }
        report(done, target.path)
        if (target.kind === 'directory') {
          let removed = 0
          await fileOps.deleteDirectory(target.path, (n, _total, p) => {
            removed = n
            report(done + n, p)
          })
          done += removed
        } else {
          await fileOps.deleteFile(target.path)
          report(++done, target.path)
        }
      }
      operations.complete(id)
    } catch (err) {
      operations.fail(id, err instanceof Error ? err.message : String(err))
    }
  }

  return {
    list: async (p) => {
      const dir = checkRemotePath(p)
      requireConnected(ftp)
      return ftp.list(dir)
    },

    mkdir: async (p) => {
      const dir = checkRemotePath(p)
      requireConnected(ftp)
      await fileOps.mkdir(dir)
      // ensureRemoteDir는 MKD의 음수 응답을 "이미 있음"으로 보고 삼킨다. 정말 폴더가 있는지 확인한다.
      const made = await findRemote(ftp, dir).catch(() => undefined)
      if (!made) {
        throw new Error(
          `The server did not create ${dir}. Check that you may write to its parent folder.`
        )
      }
      if (made.type !== 'directory') {
        throw new AgentError('TARGET_EXISTS', `${dir} already exists on the server as a file.`)
      }
    },

    rename: async (from, to) => {
      const src = checkRemotePath(from)
      const dst = checkRemotePath(to)
      requireConnected(ftp)
      // T4: 많은 서버가 RNTO로 대상을 덮어쓴다. RNFR을 보내기 전에 대상이 없는지 확인한다.
      // 대상 폴더를 읽지 못하면 확인할 수 없으므로 그 에러로 멈춘다.
      if (await findRemote(ftp, dst)) {
        throw new AgentError(
          'TARGET_EXISTS',
          `${dst} already exists on the server; rename never overwrites. Choose another name or delete it first.`
        )
      }
      await fileOps.rename(src, dst)
    },

    planDelete: async (paths) => {
      const checked = paths.map(checkRemotePath)
      if (checked.includes('/')) {
        throw new AgentError('INVALID_PATH', 'Refusing to delete the root folder of the server.')
      }
      requireConnected(ftp)
      const found = await statRemote(ftp, outermost(checked, '/'))
      const targets: DeletePlan['targets'] = []
      let totalFiles = 0
      let totalDirectories = 0
      const addFile = (): void => {
        if (++totalFiles > MAX_PLAN_ITEMS) throw tooManyItems()
      }
      const count = async (dir: string): Promise<void> => {
        totalDirectories++
        for (const entry of await listChildren(ftp, dir)) {
          // removeRemoteDirRecursive와 같이 심링크는 따라가지 않고 파일처럼 지운다
          if (entry.type === 'directory') await count(posix.join(dir, entry.name))
          else addFile()
        }
      }
      for (const { path, entry } of found) {
        if (entry.type === 'directory') {
          // §10 U4: 폴더 안 항목 수는 같은 순회에서 늘어난 개수다(폴더 자신은 뺀다).
          const before = totalFiles + totalDirectories
          await count(path)
          targets.push({
            path,
            kind: 'directory',
            entries: totalFiles + totalDirectories - before - 1
          })
        } else {
          addFile()
          targets.push({ path, kind: 'file' })
        }
      }
      return { targets, totalFiles, totalDirectories, session: sessionKey(ftp) }
    },

    startDelete: (plan) => {
      const { targets } = plan
      const job = operations.create(
        'delete',
        {
          itemCount: targets.length,
          itemName: targets.length === 1 ? posix.basename(targets[0].path) : undefined
        },
        'files',
        plan.totalFiles + plan.totalDirectories
      )
      void runDelete(job.id, plan)
      return job.id
    },

    readFile: async (p, maxBytes) => {
      const file = checkRemotePath(p)
      requireConnected(ftp)
      const entry = await findRemote(ftp, file)
      if (!entry) throw new AgentError('NOT_FOUND', `Not found on the server: ${file}`)
      if (entry.type === 'directory') {
        throw new AgentError('NOT_A_FILE', `${file} is a folder, not a file.`)
      }
      // 한 바이트 더 받아 파일이 더 긴지 안다. 미리보기처럼 보조 연결을 먼저 쓰고, 안 되면 메인 연결이다.
      const keep = maxBytes + 1
      const secondary = await ftp.createSecondaryClient().catch(() => null)
      let head: Buffer
      if (secondary) {
        const sink = headSink(keep, true)
        try {
          await secondary.downloadTo(sink.stream, file)
        } catch (err) {
          // 한도까지 모아 끊은 것은 실패가 아니다
          if (sink.head().length < keep) throw err
        } finally {
          secondary.close()
        }
        head = sink.head()
      } else {
        // 메인 연결은 끝까지 받아야 해서 그동안 GUI의 목록·이름변경이 기다린다. 큰 파일은 받지 않는다.
        if (entry.size > maxBytes) {
          throw new AgentError(
            'BUSY',
            `FTP Browser could not open a second connection to the server to read only the start ` +
              `of ${file} (${entry.size} bytes); other transfers may be using the connections ` +
              'the server allows.'
          )
        }
        const sink = headSink(keep, false)
        await ftp.runOnMainClient((client) => client.downloadTo(sink.stream, file))
        head = sink.head()
      }
      const truncated = head.length > maxBytes
      return {
        size: truncated ? entry.size : head.length,
        data: head.subarray(0, maxBytes),
        truncated
      }
    }
  }
}
