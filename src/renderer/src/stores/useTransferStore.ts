import { create } from 'zustand'
import { toast } from 'sonner'
import { t } from '@renderer/i18n'
import { parentPath, type Loc } from '@renderer/lib/explorerEntry'
import { nextRate, type RateSample } from '@renderer/lib/transferRate'
import { useListingStore } from './useListingStore'
import { connLabel, type ConnKey } from '@shared/connKey'
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
  /** 서버 간 복사(relay)만: 보내는 것 카드의 연결 */
  sourceServer?: ConnKey
  /** 이 보내기의 전송 작업(V1·V2). `askConflicts`가 기본값을 이미 정해 넣는다. */
  verb: SendVerb
}

type Decisions = Record<string, ConflictDecision>

/** 이번 보내기의 작업. 충돌 시트의 토글이 바꾸고, 한 보내기의 모든 부분이 공유한다(V3). */
export type SendVerb = 'copy' | 'move'

/** 한 보내기를 함께 보내는 부분들이 나눠 쓰는 참조. 값을 복사하면 토글이 갈린다(함정 C). */
export interface VerbRef {
  verb: SendVerb
  /**
   * 아직 충돌 시트의 답이 끝나지 않은 부분 수(F3). 0보다 크면 어느 부분도 원본을 지우지 않는다. 시트가
   * 뜨기 전(대상 확인 중)도 센다: 곧 뜰 시트의 답이 verb를 바꿀 수 있다.
   */
  open?: number
  /** `open`이 0이 되면 부를 것들 */
  idle?: Array<() => void>
}

/** 한 부분이 verb를 정하기 시작한다(F3). 반드시 `releaseVerb`와 짝을 이룬다. */
export function holdVerb(ref: VerbRef): void {
  ref.open = (ref.open ?? 0) + 1
}

/** 한 부분이 verb를 다 정했다. 마지막이면 기다리던 것들을 깨운다(F3). */
export function releaseVerb(ref: VerbRef): void {
  ref.open = (ref.open ?? 1) - 1
  if (ref.open === 0) for (const wake of ref.idle?.splice(0) ?? []) wake()
}

/** 한 보내기의 모든 부분이 verb를 다 정하면 풀린다(F3). */
export function verbSettled(ref: VerbRef): Promise<void> {
  return ref.open ? new Promise((resolve) => (ref.idle ??= []).push(resolve)) : Promise.resolve()
}

/** 충돌 시트의 답. `decisions`는 그대로, `verb`는 이 보내기 전체에 적용된다(V3·V8). */
export interface ConflictAnswer {
  decisions: Decisions
  verb: SendVerb
}

/**
 * 전송 패널(transfer-panel.md P2)의 보이기 상태. 이번 실행 동안만 둔다. 행 열쇠는 준비 중 보내기면
 * `send:<pendingId>`, 배치면 `batchKey`. 닫은 뒤 시작한 보내기만 담는다(지난 기록은 활동 팝오버의 몫).
 */
export interface TransferPanelState {
  open: boolean
  collapsed: boolean
  rows: string[]
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
  panel: TransferPanelState
  /**
   * 패널 안에서만 쓴다: 패널을 닫았을 때 아직 작업이 없던 배치(준비 중에 닫은 보내기의 배치, 준비 →
   * 작업 틈의 배치). 그 배치의 작업이 처음 보일 때 지운다. 그때 살아 있으면 패널을 열지 않는다.
   */
  panelMuted: string[]
  /**
   * 패널 안에서만 쓴다: `transfer:send`의 답을 기다리는 동안 살아난, 메타가 없는 배치. 그 보내기의 배치일
   * 수 있어 답을 기다린다(갱신이 답보다 먼저 올 수 있다, P2a). 답을 기다리는 보내기가 없어지면 행으로 붙인다.
   */
  panelHeld: string[]
  /** 패널 안에서만 쓴다: 답을 기다리는 `transfer:send` 호출 수 */
  panelSending: number
  setJobs: (jobs: TransferJob[]) => void
  /**
   * 메인이 보낸 변경분을 목록에 반영한다. 순서는 유지하고, 처음 보는 작업은 뒤에 붙인다. 메타가 없는
   * 배치(MCP·재시작 전)는 처음 볼 때 그 작업들의 연결(`job.server`)로 메타를 정해 둔다.
   */
  applyUpdate: (update: TransferUpdate) => void
  cancel: (id: string) => Promise<void>
  clearCompleted: () => Promise<void>
  /** 실패한 작업을 같은 id·배치로 다시 돈다(`transfer:retry`). 실패하면 토스트. */
  retry: (ids: string[]) => Promise<void>
  /**
   * 강제 배치로 보낸다(`transfer:send(conn, req)`, D8). `conn`은 원격 쪽 연결이다. 충돌이 있으면 시트의
   * 결정을 받아 다시 보내고, 취소하면 null. 실패하면 토스트 후 null. 큐에 넣었으면 `meta`를 그 배치에 붙인다.
   * `verbRef`를 넘기면 시트에서 고른 전송 작업(V1)이 그대로 실려 오고, 성공한 뒤 이동이면 원본 삭제를
   * 등록한다(V5).
   */
  send: (
    conn: ConnKey,
    request: TransferSendRequest,
    meta: BatchMeta,
    verbRef?: VerbRef
  ) => Promise<TransferSendResult | null>
  /**
   * 충돌 시트에 묻는다. `servers.server`는 원격 카드의 연결, `servers.sourceServer`는 서버 간 복사의 보내는 쪽.
   * `{ decisions, verb }`를 돌려주고, 취소하면 null. `verb`를 생략하면 `direction`이 'move'면 'move',
   * 아니면 'copy'(V1·V2).
   */
  askConflicts: (
    direction: ConflictPrompt['direction'],
    conflicts: TransferConflict[],
    servers?: { server?: ConnKey; sourceServer?: ConnKey },
    verb?: SendVerb
  ) => Promise<ConflictAnswer | null>
  /** 충돌 시트의 답. `null`은 보내기 취소다(V3·V8). */
  resolveConflicts: (id: string, answer: ConflictAnswer | null) => void
  /** 패널 닫기(P2b). 전송은 취소하지 않는다. */
  closePanel: () => void
  togglePanelCollapsed: () => void
}

export const isLive = (j: TransferJob): boolean => j.status === 'pending' || j.status === 'active'

/** 작업이 속한 묶음의 열쇠: 배치 id, 없으면 그 작업 혼자(`job:<id>`). */
export const batchKey = (j: Pick<TransferJob, 'id' | 'batchId'>): string =>
  j.batchId ?? `job:${j.id}`

const PANEL_CLOSED: TransferPanelState = { open: false, collapsed: false, rows: [] }

/** 새 보내기의 행을 더한다. 닫혔거나 행이 없으면 펼친 새 세션, 아니면 이어 붙인다(접힘 유지, P2·P2a). */
function withRow(panel: TransferPanelState, key: string): TransferPanelState {
  if (!panel.open || panel.rows.length === 0) return { open: true, collapsed: false, rows: [key] }
  return panel.rows.includes(key) ? panel : { ...panel, rows: [...panel.rows, key] }
}

let sendSeq = 0
/**
 * 서버 간 복사의 잘린 파일을 지웠다고 이미 알린 배치(`batchId ?? job:<id>`). 배치가 목록에서 빠져도 지우지 않는다:
 * 다시 시도한 같은 배치가 또 정리되어도 한 번 알린 것으로 충분하다(§10).
 */
const partialToasted = new Set<string>()
const conflictAnswers = new Map<string, (answer: ConflictAnswer | null) => void>()

/**
 * 토글을 쓰는 보내기의 배치 등록(V5·V9). verb와 무관하게 등록하고, 배치가 끝나고 모든 시트가 닫히면
 * 그때의 `ref.verb`로 판정한다(F3). 이동이 성립하면 한 번만 지운다.
 */
interface MoveCleanup {
  ids: string[]
  side: 'local' | 'remote'
  sources: string[]
  skipped: string[]
  ref: VerbRef
  /** 작업이 목록에 한 번이라도 보였는가. 보였던 배치가 모두 사라지면 등록을 버린다(F14). */
  seen?: boolean
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
 * 등록된 배치를 판정한다(V5·F4): 작업이 모두 끝났고 시트가 모두 닫혔을 때 등록을 빼고(두 번 지우지 않는다,
 * V9), verb가 이동이고 전부 `completed`이고 `skipped`가 없을 때만 원본을 지운다. 실패가 섞이면 재시도를
 * 기다려 등록을 남기고, 취소가 섞이거나 작업이 목록에서 모두 사라지면 지우지 않고 등록만 버린다(F14). 지우는 것은 옮긴 파일뿐이고, 원본 폴더는 재귀 삭제하지 않고 그 파일들이
 * 비운 폴더만 "비었을 때만"으로 깊은 것부터 보낸다(F2). 삭제한 원본의 폴더는 목록에서 무효화해야
 * 사라진 게 보인다(함정 E). 실패하면 토스트만 하고 다시 시도하지 않는다(V9·V10).
 */
async function runMoveCleanup(
  jobs: readonly TransferJob[],
  left: readonly TransferJob[] = jobs
): Promise<void> {
  for (const move of [...moveCleanups]) {
    // 겹친 실행이 이미 처리한 등록은 건너뛴다(F4). 확인과 제거 사이에 await가 없어야 한다.
    const at = moveCleanups.indexOf(move)
    if (at < 0) continue
    const found = jobs.filter((j) => move.ids.includes(j.id))
    if (found.length) move.seen = true
    // 한 번 보였던 배치의 작업이 목록에서 모두 사라졌다(완료 목록 지우기): 지우지 않고 등록만 버린다(F14).
    const gone = move.seen === true && !left.some((j) => move.ids.includes(j.id))
    if (!gone) {
      if (move.ref.open || found.length === 0 || found.some(isLive)) continue
      // 실패한 작업은 같은 id로 다시 시도될 수 있어 등록을 남긴다. 취소가 섞이면 버린다(F14).
      const failed = found.some((j) => j.status === 'failed')
      if (failed && !found.some((j) => j.status === 'cancelled')) continue
    }
    moveCleanups.splice(at, 1)
    if (gone || move.ref.verb !== 'move' || move.skipped.length > 0) continue
    if (found.some((j) => j.status !== 'completed')) continue
    const sep = move.side === 'local' ? /[\\/]/ : /\//
    const files = found.map((j) => (move.side === 'local' ? j.localPath : j.remotePath))
    // 폴더 원본 안의 파일이면 그 파일의 폴더부터 원본 폴더까지가 비었을 수 있다.
    const dirs = new Set<string>()
    for (const file of files) {
      const root = move.sources.find((s) => file.startsWith(s) && sep.test(file[s.length] ?? ''))
      if (!root) continue
      for (
        let d = parentPath(move.side, file);
        d && d.length >= root.length;
        d = parentPath(move.side, d)
      )
        dirs.add(d)
    }
    const targets = [
      ...files.map((path) => ({ path, isDirectory: false })),
      ...[...dirs]
        .sort((a, b) => b.length - a.length)
        .map((path) => ({ path, isDirectory: true, onlyIfEmpty: true }))
    ]
    // 원격 원본 삭제는 그 작업을 처리한 연결(`job.server`)로 보낸다.
    const server = found[0].server
    const r =
      move.side === 'local'
        ? await window.api.invoke<IpcResult<void>>('local:deleteBatch', targets)
        : await window.api.invoke<IpcResult<void>>('ftp:deleteBatch', server, targets)
    if (r.success) {
      const shown = new Set(
        targets.map((x) => parentPath(move.side, x.path)).filter((d): d is string => d !== null)
      )
      for (const dir of shown)
        useListingStore
          .getState()
          .invalidate(move.side, move.side === 'remote' ? server : undefined, dir)
    } else {
      toast(t('toast.moveCleanupFailed'), { description: r.error })
    }
  }
}

/**
 * 메타가 없는 배치(MCP·재시작 전): 첫 파일 이름과 공통 대상 폴더로 이름표를 만든다. 원격 목적지(업로드,
 * 서버 간 복사)의 서버는 작업의 연결(`job.server`, 받는 쪽)이다.
 */
export function fallbackBatchMeta(jobs: readonly TransferJob[]): BatchMeta {
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
  const server = jobs[0]?.server
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
  panel: PANEL_CLOSED,
  panelMuted: [],
  panelHeld: [],
  panelSending: 0,

  setJobs: (jobs) => set({ jobs }),

  applyUpdate: ({ upserts, removedIds }) => {
    if (upserts.length === 0 && removedIds.length === 0) return

    const jobs = [...get().jobs]
    const wasLive = new Set(jobs.filter(isLive).map(batchKey))
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
      // main이 받는 쪽의 잘린 파일을 실제로 지웠을 때만 알린다(MC26). 상태나 오류 문구로 짐작하지 않는다
      if (job.partialRemoved && !before?.partialRemoved) {
        const batch = job.batchId ?? `job:${job.id}`
        if (!partialToasted.has(batch)) {
          partialToasted.add(batch)
          toast(
            t('toast.relayPartialRemoved', { name: job.fileName, server: connLabel(job.server) })
          )
        }
      }
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
    const knownMeta = get().batchMeta
    let batchMeta = knownMeta
    for (const upsert of upserts) {
      const key = batchKey(upsert)
      if (batchMeta[key]) continue
      const list = jobs.filter((j) => batchKey(j) === key)
      batchMeta = { ...batchMeta, [key]: fallbackBatchMeta(list) }
    }
    for (const id of removedIds) delete rates[id]
    const removed = new Set(removedIds)
    const next = removed.size ? jobs.filter((job) => !removed.has(job.id)) : jobs
    // 성립한 이동 배치는 여기서 한 번만 원본을 지운다(V5·V9). 지우기 전에 본 `jobs`(삭제 전 상태)로 판정하고,
    // 목록에서 모두 사라졌는지는 지운 뒤의 `next`로 본다(F14).
    void runMoveCleanup(jobs, next)

    // 패널(P2): 새로 살아난 배치가 새 보내기다. 막아 둔 배치는 작업이 처음 보일 때(상태와 상관없이)
    // 잊고, 그때 살아 있어도 열지 않는다. 답을 기다리는 보내기가 있으면 메타 없는 배치는 붙잡아 둔다.
    let { panel, panelMuted, panelHeld } = get()
    const left = new Set(next.map(batchKey))
    const muted = new Set(panelMuted.filter((k) => left.has(k)))
    if (muted.size) panelMuted = panelMuted.filter((k) => !muted.has(k))
    for (const key of new Set(next.filter(isLive).map(batchKey))) {
      if (wasLive.has(key) || muted.has(key) || panelHeld.includes(key)) continue
      if (get().panelSending > 0 && !knownMeta[key]) panelHeld = [...panelHeld, key]
      else panel = withRow(panel, key)
    }
    // 작업이 모두 지워진 배치(완료 지우기)의 행을 버린다(P2d).
    const gone = new Set(jobs.filter((j) => removed.has(j.id)).map(batchKey))
    for (const key of left) gone.delete(key)
    if (gone.size && panel.rows.some((k) => gone.has(k)))
      panel = { ...panel, rows: panel.rows.filter((k) => !gone.has(k)) }
    set({ jobs: next, rates, batchMeta, panel, panelMuted, panelHeld })
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

  send: async (conn, request, meta, verbRef) => {
    const id = `send${++sendSeq}`
    const row = `send:${id}`
    set((s) => ({
      pendingSends: [...s.pendingSends, { id, label: meta.label }],
      panel: withRow(s.panel, row)
    }))
    // 토글을 쓰지 않는 보내기(서버 간 복사)는 혼자 쓰는 참조로 시트의 기본값만 정한다.
    const ref: VerbRef = verbRef ?? { verb: 'copy' }
    holdVerb(ref)
    try {
      let req = request
      for (;;) {
        let result: IpcResult<TransferSendResult> | undefined
        set((s) => ({ panelSending: s.panelSending + 1 }))
        try {
          result = await window.api.invoke<IpcResult<TransferSendResult>>(
            'transfer:send',
            conn,
            req
          )
        } finally {
          const batchId =
            result?.success && result.data.conflicts.length === 0 ? result.data.batchId : undefined
          set((s) => {
            let { batchMeta, panel, panelMuted } = s
            let panelHeld = s.panelHeld.filter((k) => k !== batchId)
            if (batchId) {
              batchMeta = { ...batchMeta, [batchId]: meta }
              // 준비 행을 제자리에서 그 배치로 바꾼다. 준비 중에 닫았으면 그 배치가 살아나도 열지 않는다.
              if (panel.rows.includes(row)) {
                const rows = panel.rows.filter((k) => k !== batchId)
                panel = { ...panel, rows: rows.map((k) => (k === row ? batchId : k)) }
              } else if (!s.jobs.some((j) => j.batchId === batchId)) {
                panelMuted = [...panelMuted, batchId]
              }
            }
            // 기다리는 답이 없으면 붙잡아 둔 다른 배치(MCP 등)를 새 보내기로 붙인다.
            const panelSending = s.panelSending - 1
            if (panelSending === 0) {
              for (const key of panelHeld)
                if (s.jobs.some((j) => batchKey(j) === key)) panel = withRow(panel, key)
              panelHeld = []
            }
            return { batchMeta, panel, panelMuted, panelHeld, panelSending }
          })
        }
        if (!result.success) {
          toast.error(t('toast.sendFailed'), { description: result.error })
          return null
        }
        const data = result.data
        if (data.conflicts.length === 0) {
          if (data.skipped.length) toast(t('toast.sendSkipped', { count: data.skipped.length }))
          // 토글을 쓰는 보내기는 verb와 무관하게 등록하고, 판정 때 `ref.verb`를 읽는다(V5·F3). 성립
          // 여부(verb·전체 완료·건너뜀 없음)는 runMoveCleanup이 판정한다(함정 A). 등록은 enqueue 성공
          // 시에만 하고, 갱신이 답보다 먼저 왔을 수 있어 모든 부분이 정해지면 한 번 판정한다(F4).
          if (verbRef && data.ids.length) {
            moveCleanups.push({
              ids: data.ids,
              side: request.direction === 'upload' ? 'local' : 'remote',
              sources: request.sources,
              skipped: data.skipped.map((s) => s.path),
              ref: verbRef
            })
            void verbSettled(verbRef).then(() => runMoveCleanup(get().jobs))
          }
          return data
        }
        // 결정을 모아 같은 요청을 다시 보낸다. 그사이 새로 생긴 충돌은 main이 다시 돌려준다.
        // 토글 값은 다음 라운드에도 넘겨 사용자의 선택이 리셋되지 않는다(V8).
        const servers = req.sourceServer
          ? { server: conn, sourceServer: req.sourceServer }
          : { server: conn }
        const answer = await get().askConflicts(req.direction, data.conflicts, servers, ref.verb)
        if (!answer) return null
        ref.verb = answer.verb // 한 보내기의 모든 부분이 같은 값을 쓴다(V3·함정 C)
        req = { ...req, decisions: { ...req.decisions, ...answer.decisions } }
      }
    } finally {
      releaseVerb(ref)
      // 배치 없이 끝난 보내기(실패·충돌 시트 취소·모두 건너뜀)의 준비 행은 버린다.
      set((s) => ({
        pendingSends: s.pendingSends.filter((p) => p.id !== id),
        panel: s.panel.rows.includes(row)
          ? { ...s.panel, rows: s.panel.rows.filter((k) => k !== row) }
          : s.panel
      }))
    }
  },

  askConflicts: (direction, conflicts, servers = {}, verb) => {
    const id = `ask${++sendSeq}`
    // 원격↔원격은 이동이 기본이고 복사는 막혀 있다(V2). 그 외(서버 간 복사 포함)는 복사가 기본이다(V1).
    const resolved = verb ?? (direction === 'move' ? 'move' : 'copy')
    return new Promise((resolve) => {
      conflictAnswers.set(id, resolve)
      set((s) => ({
        conflictQueue: [
          ...s.conflictQueue,
          { id, direction, conflicts, verb: resolved, ...servers }
        ]
      }))
    })
  },

  resolveConflicts: (id, answer) => {
    set((s) => ({ conflictQueue: s.conflictQueue.filter((p) => p.id !== id) }))
    conflictAnswers.get(id)?.(answer)
    conflictAnswers.delete(id)
  },

  closePanel: () =>
    set((s) => ({
      panel: PANEL_CLOSED,
      // 붙잡아 둔 배치는 이미 살아 있다: 닫은 뒤 다시 열지 않는다.
      panelHeld: [],
      // 틈의 배치(아직 작업이 없다)는 살아나도 다시 열지 않는다. 준비 행은 `send`가 맡는다.
      panelMuted: [
        ...s.panelMuted,
        ...s.panel.rows.filter(
          (k) => !k.startsWith('send:') && !s.jobs.some((j) => batchKey(j) === k)
        )
      ]
    })),

  togglePanelCollapsed: () => set((s) => ({ panel: { ...s.panel, collapsed: !s.panel.collapsed } }))
}))
