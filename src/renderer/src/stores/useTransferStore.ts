import { create } from 'zustand'
import { toast } from 'sonner'
import { t } from '@renderer/i18n'
import { parentPath, type Loc } from '@renderer/lib/explorerEntry'
import { nextRate, type RateSample } from '@renderer/lib/transferRate'
import { useListingStore } from './useListingStore'
import type {
  ConflictDecision,
  TransferConflict,
  TransferDirection,
  TransferJob,
  TransferSendRequest,
  TransferSendResult,
  TransferUpdate
} from '@shared/types/transfer'
import type { IpcResult } from '@shared/types/ipc'

/** 배치의 표시 정보: 활동 팝오버의 이름표와 "탭에서 보기"의 목적지(D14). */
export interface BatchMeta {
  label: string
  to: Loc
}

/** 결정을 기다리는 보내기 한 번의 충돌들. 충돌 시트가 `resolveConflicts`로 답한다. */
export interface ConflictPrompt {
  id: string
  /** 전송 방향, 또는 같은 쪽 보내기의 원격 이동·로컬 복사(D32) */
  direction: TransferDirection | 'move' | 'copy'
  conflicts: TransferConflict[]
  /** 이 보내기의 전송 작업(V1·V2). `askConflicts`가 기본값을 이미 정해 넣는다. */
  verb: SendVerb
}

type Decisions = Record<string, ConflictDecision>

/** 이번 보내기의 작업. 충돌 시트의 토글이 바꾸고, 한 보내기의 모든 부분이 공유한다(V3). */
export type SendVerb = 'copy' | 'move'

/** 한 보내기를 함께 보내는 부분들이 나눠 쓰는 참조. 값을 복사하면 토글이 갈린다(함정 C). */
export interface VerbRef {
  verb: SendVerb
}

/** 충돌 시트의 답. `decisions`는 그대로, `verb`는 이 보내기 전체에 적용된다(V3·V8). */
export interface ConflictAnswer {
  decisions: Decisions
  verb: SendVerb
}

interface TransferStore {
  jobs: TransferJob[]
  batchMeta: Record<string, BatchMeta>
  /** 작업별 속도 표본(진행 중인 작업만) */
  rates: Record<string, RateSample>
  /** 계획 중인 보내기(활동 팝오버의 "준비 중" 행) */
  pendingSends: Array<{ id: string; label: string }>
  /** 앞의 것부터 충돌 시트가 묻는다 */
  conflictQueue: ConflictPrompt[]
  setJobs: (jobs: TransferJob[]) => void
  /**
   * 메인이 보낸 변경분을 목록에 반영한다. 순서는 유지하고, 처음 보는 작업은 뒤에 붙인다. 메타가 없는
   * 배치(MCP·재시작 전)는 처음 볼 때 `server`(그때 연결의 서버 키)로 메타를 정해 둔다.
   */
  applyUpdate: (update: TransferUpdate, server?: string) => void
  cancel: (id: string) => Promise<void>
  clearCompleted: () => Promise<void>
  /** 실패한 작업을 같은 id·배치로 다시 돈다(`transfer:retry`). 실패하면 토스트. */
  retry: (ids: string[]) => Promise<void>
  /**
   * 강제 배치로 보낸다(`transfer:send`, D8). 충돌이 있으면 시트의 결정을 받아 다시 보내고,
   * 취소하면 null. 실패하면 토스트 후 null. 큐에 넣었으면 `meta`를 그 배치에 붙인다.
   * `verbRef`를 넘기면 시트에서 고른 전송 작업(V1)이 그대로 실려 오고, 성공한 뒤 이동이면
   * 원본 삭제를 등록한다(V5).
   */
  send: (
    request: TransferSendRequest,
    meta: BatchMeta,
    verbRef?: VerbRef
  ) => Promise<TransferSendResult | null>
  /**
   * 충돌 시트에 묻는다. `{ decisions, verb }`를 돌려주고, 취소하면 null.
   * `verb`를 생략하면 `direction`이 'move'면 'move', 아니면 'copy'(V1·V2).
   */
  askConflicts: (
    direction: ConflictPrompt['direction'],
    conflicts: TransferConflict[],
    verb?: SendVerb
  ) => Promise<ConflictAnswer | null>
  /** 충돌 시트의 답. `null`은 보내기 취소다. */
  resolveConflicts: (id: string, answer: ConflictAnswer | null) => void
}

let sendSeq = 0
const conflictAnswers = new Map<string, (answer: ConflictAnswer | null) => void>()

/** 이동으로 보낸 배치의 원본 삭제 등록(V5·V9). 배치가 성립하면 `applyUpdate`가 한 번만 지운다. */
interface MoveCleanup {
  ids: string[]
  side: 'local' | 'remote'
  sources: string[]
  skipped: string[]
}

const moveCleanups: MoveCleanup[] = []

/** 완료된 다운로드의 로컬 폴더들. 디바운스 뒤 폴더마다 한 번 목록을 무효화한다. */
const DOWNLOAD_REFRESH_MS = 300
const doneDirs = new Set<string>()
let doneTimer: ReturnType<typeof setTimeout> | undefined

function refreshDownloadedDirs(): void {
  const dirs = [...doneDirs]
  doneDirs.clear()
  for (const dir of dirs) useListingStore.getState().invalidate('local', undefined, dir)
}

/**
 * 등록된 이동 배치의 원본을 지운다(V5): 그 배치의 작업이 전부 `completed`이고 `skipped`가 없을 때만
 * 삭제하고, 성공·실패와 무관하게 등록을 빼 두 번 지우지 않는다(V9). 건너뛴 항목의 원본까지 재귀
 * 삭제하면 데이터 유실이라(함정 A) 어느 조건도 생략할 수 없다.
 */
async function runMoveCleanup(jobs: readonly TransferJob[], server?: string): Promise<void> {
  for (const move of [...moveCleanups]) {
    const found = jobs.filter((j) => move.ids.includes(j.id))
    if (found.length === 0 || found.some((j) => j.status !== 'completed')) continue
    moveCleanups.splice(moveCleanups.indexOf(move), 1)
    if (move.skipped.length > 0) continue
    const channel = move.side === 'local' ? 'local:deleteBatch' : 'ftp:deleteBatch'
    // 원격 원본 삭제는 그 작업을 처리한 세션의 server로 보낸다(A′1·A′3).
    const r =
      move.side === 'local'
        ? await window.api.invoke<IpcResult<void>>(channel, move.sources)
        : await window.api.invoke<IpcResult<void>>(
            channel,
            move.sources,
            ...(server ? [server] : [])
          )
    if (r.success) {
      // 사라진 원본 폴더가 목록에 그대로 남지 않게 무효화한다(함정 E).
      const dirs = new Set(
        move.sources.map((s) => parentPath(move.side, s)).filter((d): d is string => d !== null)
      )
      for (const dir of dirs)
        useListingStore
          .getState()
          .invalidate(move.side, move.side === 'remote' ? server : undefined, dir)
    } else {
      toast(t('toast.moveCleanupFailed'), { description: r.error })
    }
  }
}

/** 메타가 없는 배치(MCP·재시작 전): 첫 파일 이름과 공통 대상 폴더로 이름표를 만든다. */
export function fallbackBatchMeta(jobs: readonly TransferJob[], server?: string): BatchMeta {
  const side = jobs[0]?.direction === 'download' ? 'local' : 'remote'
  const seps = side === 'local' ? ['\\', '/'] : ['/']
  const dirs = jobs.map(
    (j) => parentPath(side, side === 'local' ? j.localPath : j.remotePath) ?? ''
  )
  let common = dirs[0] ?? ''
  for (const dir of dirs) {
    while (common && dir !== common && !seps.some((s) => dir.startsWith(common + s)))
      common = parentPath(side, common) ?? ''
  }
  const name = jobs[0]?.fileName ?? ''
  return {
    label: jobs.length > 1 ? t('activity.labelMany', { name, count: jobs.length - 1 }) : name,
    to: { side, path: common, ...(side === 'remote' && server ? { server } : {}) }
  }
}

export const useTransferStore = create<TransferStore>((set, get) => ({
  jobs: [],
  batchMeta: {},
  rates: {},
  pendingSends: [],
  conflictQueue: [],

  setJobs: (jobs) => set({ jobs }),

  applyUpdate: ({ upserts, removedIds }, server) => {
    if (upserts.length === 0 && removedIds.length === 0) return

    const jobs = [...get().jobs]
    const indexById = new Map(jobs.map((job, index) => [job.id, index]))
    const rates = { ...get().rates }
    const now = Date.now()
    for (const job of upserts) {
      const index = indexById.get(job.id)
      const before = index === undefined ? undefined : jobs[index]
      if (index === undefined) {
        indexById.set(job.id, jobs.length)
        jobs.push(job)
      } else {
        jobs[index] = job
      }
      if (job.status === 'active')
        rates[job.id] = nextRate(rates[job.id], job.transferredBytes, now)
      else delete rates[job.id]
      // 받은 파일이 로컬 목록에 보이게 한다. 업로드는 main이 ftp:remoteChanged로 이미 알린다
      // (만든 폴더마다 mkdir). 다운로드도 같게: 파일의 폴더부터 배치 목적지까지 그 사이 폴더를 모두.
      if (
        job.direction === 'download' &&
        job.status === 'completed' &&
        before?.status !== 'completed'
      ) {
        const top = job.batchId ? get().batchMeta[job.batchId]?.to.path : undefined
        for (let dir = parentPath('local', job.localPath); dir; dir = parentPath('local', dir)) {
          doneDirs.add(dir)
          if (!top || dir.length <= top.length || !dir.startsWith(top)) break
        }
      }
    }
    if (doneDirs.size) {
      clearTimeout(doneTimer)
      doneTimer = setTimeout(refreshDownloadedDirs, DOWNLOAD_REFRESH_MS)
    }
    // 나중에 다른 서버에 연결해도 이름표·목적지가 바뀌지 않게 처음 본 때에 정한다.
    let batchMeta = get().batchMeta
    for (const { id, batchId } of upserts) {
      const key = batchId ?? `job:${id}`
      if (batchMeta[key]) continue
      const list = jobs.filter((j) => (j.batchId ?? `job:${j.id}`) === key)
      batchMeta = { ...batchMeta, [key]: fallbackBatchMeta(list, server) }
    }
    // 성립한 이동 배치는 여기서 한 번만 원본을 지운다(V5·V9).
    void runMoveCleanup(jobs, server)
    for (const id of removedIds) delete rates[id]
    if (removedIds.length === 0) {
      set({ jobs, rates, batchMeta })
      return
    }
    const removed = new Set(removedIds)
    set({ jobs: jobs.filter((job) => !removed.has(job.id)), rates, batchMeta })
  },

  cancel: async (id) => {
    await window.api.invoke('transfer:cancel', id)
  },

  clearCompleted: async () => {
    await window.api.invoke('transfer:clearCompleted')
  },

  retry: async (ids) => {
    const result = await window.api.invoke<IpcResult<void>>('transfer:retry', ids)
    if (!result.success) toast.error(t('toast.retryFailed'), { description: result.error })
  },

  send: async (request, meta, verbRef) => {
    const id = `send${++sendSeq}`
    set((s) => ({ pendingSends: [...s.pendingSends, { id, label: meta.label }] }))
    try {
      let req = request
      let verb: SendVerb = verbRef?.verb ?? 'copy'
      for (;;) {
        // A′1: 목적지(meta.to)의 세션 키를 보낸다(A′3 — 활성 세션이 아니라 목적지 기준).
        const result = await window.api.invoke<IpcResult<TransferSendResult>>(
          'transfer:send',
          req,
          ...(meta.to.server ? [meta.to.server] : [])
        )
        if (!result.success) {
          toast.error(t('toast.sendFailed'), { description: result.error })
          return null
        }
        const data = result.data
        if (data.conflicts.length === 0) {
          const batchId = data.batchId
          if (batchId) set((s) => ({ batchMeta: { ...s.batchMeta, [batchId]: meta } }))
          if (data.skipped.length) toast(t('toast.sendSkipped', { count: data.skipped.length }))
          // 이동이면 완료 후 원본 삭제를 등록한다(V5). 성립 여부는 applyUpdate가 판정한다.
          if (verb === 'move' && data.ids.length)
            moveCleanups.push({
              ids: data.ids,
              side: request.direction === 'upload' ? 'local' : 'remote',
              sources: request.sources,
              skipped: data.skipped.map((s) => s.path)
            })
          return data
        }
        // 결정을 모아 같은 요청을 다시 보낸다. 그사이 새로 생긴 충돌은 main이 다시 돌려준다.
        // 토글 값은 다음 라운드에도 넘겨 사용자의 선택이 리셋되지 않는다(V8).
        const answer = await get().askConflicts(req.direction, data.conflicts, verb)
        if (!answer) return null
        verb = answer.verb
        if (verbRef) verbRef.verb = answer.verb // 한 보내기의 모든 부분이 같은 값을 쓴다(V3·함정 C)
        req = { ...req, decisions: { ...req.decisions, ...answer.decisions } }
      }
    } finally {
      set((s) => ({ pendingSends: s.pendingSends.filter((p) => p.id !== id) }))
    }
  },

  askConflicts: (direction, conflicts, verb) => {
    const id = `ask${++sendSeq}`
    // 원격↔원격은 이동이 기본이고 복사는 막혀 있다(V2). 그 외는 복사가 기본이다(V1).
    const resolved = verb ?? (direction === 'move' ? 'move' : 'copy')
    return new Promise((resolve) => {
      conflictAnswers.set(id, resolve)
      set((s) => ({
        conflictQueue: [...s.conflictQueue, { id, direction, conflicts, verb: resolved }]
      }))
    })
  },

  resolveConflicts: (id, answer) => {
    set((s) => ({ conflictQueue: s.conflictQueue.filter((p) => p.id !== id) }))
    conflictAnswers.get(id)?.(answer)
    conflictAnswers.delete(id)
  }
}))
