import { create } from 'zustand'
import { toast } from 'sonner'
import { t } from '@renderer/i18n'
import { parentPath, type Loc } from '@renderer/lib/explorerEntry'
import { nextRate, type RateSample } from '@renderer/lib/transferRate'
import { useListingStore } from './useListingStore'
import type { ConnKey } from '@shared/connKey'
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
  /** 원격 카드의 연결(받는 쪽, 같은 쪽 원격 이동이면 그 서버). 로컬 복사에는 없다 */
  server?: ConnKey
}

type Decisions = Record<string, ConflictDecision>

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
   * 강제 배치로 보낸다(`transfer:send(conn, req)`, D8). `conn`은 원격 쪽 연결이다. 충돌이 있으면 시트의
   * 결정을 받아 다시 보내고, 취소하면 null. 실패하면 토스트 후 null. 큐에 넣었으면 `meta`를 그 배치에 붙인다.
   */
  send: (
    conn: ConnKey,
    request: TransferSendRequest,
    meta: BatchMeta
  ) => Promise<TransferSendResult | null>
  /** 충돌 시트에 묻는다. `servers.server`는 원격 카드의 연결. 결정을 돌려주고, 취소하면 null. */
  askConflicts: (
    direction: ConflictPrompt['direction'],
    conflicts: TransferConflict[],
    servers?: { server?: ConnKey }
  ) => Promise<Decisions | null>
  /** 충돌 시트의 답. `null`은 보내기 취소다. */
  resolveConflicts: (id: string, decisions: Decisions | null) => void
}

let sendSeq = 0
const conflictAnswers = new Map<string, (decisions: Decisions | null) => void>()

/** 완료된 다운로드의 로컬 폴더들. 디바운스 뒤 폴더마다 한 번 목록을 무효화한다. */
const DOWNLOAD_REFRESH_MS = 300
const doneDirs = new Set<string>()
let doneTimer: ReturnType<typeof setTimeout> | undefined

function refreshDownloadedDirs(): void {
  const dirs = [...doneDirs]
  doneDirs.clear()
  for (const dir of dirs) useListingStore.getState().invalidate('local', undefined, dir)
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

  send: async (conn, request, meta) => {
    const id = `send${++sendSeq}`
    set((s) => ({ pendingSends: [...s.pendingSends, { id, label: meta.label }] }))
    try {
      let req = request
      for (;;) {
        const result = await window.api.invoke<IpcResult<TransferSendResult>>(
          'transfer:send',
          conn,
          req
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
          return data
        }
        // 결정을 모아 같은 요청을 다시 보낸다. 그사이 새로 생긴 충돌은 main이 다시 돌려준다.
        const decisions = await get().askConflicts(req.direction, data.conflicts, { server: conn })
        if (!decisions) return null
        req = { ...req, decisions: { ...req.decisions, ...decisions } }
      }
    } finally {
      set((s) => ({ pendingSends: s.pendingSends.filter((p) => p.id !== id) }))
    }
  },

  askConflicts: (direction, conflicts, servers = {}) => {
    const id = `ask${++sendSeq}`
    return new Promise((resolve) => {
      conflictAnswers.set(id, resolve)
      set((s) => ({
        conflictQueue: [...s.conflictQueue, { id, direction, conflicts, ...servers }]
      }))
    })
  },

  resolveConflicts: (id, decisions) => {
    set((s) => ({ conflictQueue: s.conflictQueue.filter((p) => p.id !== id) }))
    conflictAnswers.get(id)?.(decisions)
    conflictAnswers.delete(id)
  }
}))
