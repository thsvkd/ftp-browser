/**
 * 같은 쪽 보내기(원격 이동·로컬 복사)의 충돌 계획(순수, D32). 대상 폴더의 맨 위 이름만 견주고,
 * 결정이 없는 충돌은 `conflicts`로 돌려준다(`transfer:send`의 두 단계와 같은 모양).
 */
import { uniqueLocalNames } from '@shared/entryName'
import { joinPath, type ExplorerEntry, type Side } from './explorerEntry'
import type { ConflictDecision, TransferConflict } from '@shared/types/transfer'

export type SameSideItem = Pick<ExplorerEntry, 'path' | 'name' | 'type' | 'size' | 'modifiedAt'>

/** 실행할 동작 하나: `source`를 대상 폴더의 `name`으로. `overwrite`면 그 이름의 파일이 이미 있다. */
export interface SameSideOp {
  source: string
  name: string
  overwrite: boolean
}

export function planSameSide(
  items: readonly SameSideItem[],
  existing: readonly SameSideItem[],
  dest: { side: Side; path: string },
  platform: string,
  decisions: Record<string, ConflictDecision> = {}
): { ops: SameSideOp[]; conflicts: TransferConflict[] } {
  // 원격은 대소문자를 구분한다(업로드와 같다, D10).
  const names = dest.side === 'local' ? platform : 'linux'
  const ignoreCase = names === 'win32' || names === 'darwin'
  const key = (n: string): string => (ignoreCase ? n.toLowerCase() : n)
  const there = new Map(existing.map((e) => [key(e.name), e]))
  // 둘 다 두기의 새 이름은 대상 폴더와 함께 보내는 이름을 모두 피한다.
  const taken = new Map([...existing, ...items].map((e) => [key(e.name), e.name]))
  const freeName = (name: string): string => {
    const free = uniqueLocalNames([...taken.values(), name], names).at(-1)!
    taken.set(key(free), free)
    return free
  }
  const ops: SameSideOp[] = []
  const conflicts: TransferConflict[] = []
  const sent = new Set<string>()
  for (const item of items) {
    const target = joinPath(dest.side, dest.path, item.name)
    // 이미 그 자리에 있다. 이름과 같은 규칙으로 견준다(Windows에서 대소문자만 다른 경로는 같은 파일).
    if (key(target) === key(item.path)) continue
    // 한 번에 보내는 항목끼리 이름이 같으면 뒤의 것에 번호를 붙인다. 서로 덮어쓰지 않는다.
    if (sent.has(key(item.name))) {
      ops.push({ source: item.path, name: freeName(item.name), overwrite: false })
      continue
    }
    sent.add(key(item.name))
    const hit = there.get(key(item.name))
    if (!hit) {
      ops.push({ source: item.path, name: item.name, overwrite: false })
      continue
    }
    // 폴더 덮어쓰기는 재귀 삭제·섞어 쓰기가 되므로 둘 다 두기만 한다(D9와 같은 이유).
    const folder = item.type === 'directory' || hit.type === 'directory'
    const decision = decisions[target]
    if (!decision) {
      conflicts.push({
        target,
        source: item.path,
        name: item.name,
        incoming: { size: item.size, modifiedAt: item.modifiedAt },
        existing: { size: hit.size, modifiedAt: hit.modifiedAt },
        folder
      })
    } else if (decision === 'rename') {
      ops.push({ source: item.path, name: freeName(item.name), overwrite: false })
    } else if (
      !folder &&
      (decision === 'overwrite' ||
        (decision === 'newer' && Date.parse(item.modifiedAt) > Date.parse(hit.modifiedAt)))
    ) {
      ops.push({ source: item.path, name: item.name, overwrite: true })
    }
  }
  return { ops, conflicts }
}
