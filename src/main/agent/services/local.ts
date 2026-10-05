import { lstat, readdir } from 'fs/promises'
import type { Stats } from 'fs'
import path from 'path'
import { AgentError, MAX_PLAN_ITEMS, type AgentServices, type DeletePlan } from '../types'
import { checkLocalPath, outermost, tooManyItems } from './paths'
import type { AgentServiceDeps } from './index'

/** 심링크를 따라가지 않는다(끊긴 링크도 "있음"). 없으면 null. */
async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export function createLocalService(
  deps: Pick<AgentServiceDeps, 'localFs' | 'operations' | 'events'>
): AgentServices['local'] {
  const { localFs, operations, events } = deps

  /** local:deleteBatch와 같다. 끝나면(실패·취소 포함) 로컬 패널이 새로 고치도록 알린다(G2). */
  const runDelete = async (id: string, targets: DeletePlan['targets']): Promise<void> => {
    try {
      for (let i = 0; i < targets.length; i++) {
        if (operations.isCancelled(id)) {
          operations.markCancelled(id)
          return
        }
        const target = targets[i]
        operations.progress(id, i, path.basename(target.path))
        await localFs.delete(target.path, target.kind === 'directory')
        operations.progress(id, i + 1, path.basename(target.path))
      }
      operations.complete(id)
    } catch (err) {
      operations.fail(id, err instanceof Error ? err.message : String(err))
    } finally {
      events.localChanged({ paths: targets.map((t) => t.path) })
    }
  }

  return {
    list: async (p) => localFs.list(checkLocalPath(p)),

    mkdir: async (p) => {
      const dir = checkLocalPath(p)
      await localFs.mkdir(dir)
      events.localChanged({ paths: [dir] })
    },

    rename: async (from, to) => {
      const src = checkLocalPath(from)
      const dst = checkLocalPath(to)
      // LocalFileSystem.rename도 같은 규칙으로 막지만, 에이전트가 고칠 수 있는 코드로 알린다(T4)
      if (path.dirname(path.resolve(src)) !== path.dirname(path.resolve(dst))) {
        throw new AgentError(
          'INVALID_PATH',
          'rename_local keeps an item in its folder: give the new name in the same folder.'
        )
      }
      if (await lstatOrNull(dst)) {
        throw new AgentError(
          'TARGET_EXISTS',
          `${dst} already exists; rename never overwrites. Choose another name or delete it first.`
        )
      }
      await localFs.rename(src, dst)
      events.localChanged({ paths: [src, dst] })
    },

    planDelete: async (paths) => {
      const checked = paths.map((p) => path.resolve(checkLocalPath(p)))
      for (const p of checked) {
        if (path.parse(p).root === p) {
          throw new AgentError('INVALID_PATH', `Refusing to delete the root folder ${p}.`)
        }
      }
      const targets: DeletePlan['targets'] = []
      let totalFiles = 0
      let totalDirectories = 0
      const addFile = (): void => {
        if (++totalFiles > MAX_PLAN_ITEMS) throw tooManyItems()
      }
      const count = async (dir: string): Promise<void> => {
        totalDirectories++
        // Dirent는 심링크를 따라가지 않는다. fs.rm도 링크만 지운다.
        for (const dirent of await readdir(dir, { withFileTypes: true })) {
          if (dirent.isDirectory()) await count(path.join(dir, dirent.name))
          else addFile()
        }
      }
      for (const p of outermost(checked, path.sep)) {
        const st = await lstatOrNull(p)
        if (!st) throw new AgentError('NOT_FOUND', `Not found: ${p}`)
        if (st.isDirectory()) {
          targets.push({ path: p, kind: 'directory' })
          await count(p)
        } else {
          targets.push({ path: p, kind: 'file' })
          addFile()
        }
      }
      return { targets, totalFiles, totalDirectories }
    },

    startDelete: (plan) => {
      const { targets } = plan
      const job = operations.create(
        'delete',
        {
          itemCount: targets.length,
          itemName: targets.length === 1 ? path.basename(targets[0].path) : undefined
        },
        'files',
        targets.length
      )
      void runDelete(job.id, targets)
      return job.id
    }
  }
}
