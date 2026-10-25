export type TransferDirection = 'upload' | 'download'
export type TransferStatus = 'pending' | 'active' | 'completed' | 'failed' | 'cancelled'

export interface TransferEnqueueItem {
  localPath: string
  remotePath: string
  fileName: string
  totalBytes: number
}

export interface TransferJob {
  id: string
  /** Shared by files enqueued as one multi-file/folder transfer. */
  batchId?: string
  direction: TransferDirection
  localPath: string
  remotePath: string
  fileName: string
  totalBytes: number
  transferredBytes: number
  status: TransferStatus
  error?: string
  retryCount?: number
  startedAt?: string
  completedAt?: string
}

/**
 * 메인 프로세스가 일정 주기(`FLUSH_MS`)로 모아서 보내는 변경분.
 * `upserts`는 마지막 전송 이후 바뀐 작업의 스냅샷(진행률 포함), `removedIds`는 목록에서 빠진 작업이다.
 */
export interface TransferUpdate {
  upserts: TransferJob[]
  removedIds: string[]
  /** 어느 세션의 전송인지(M5·M1). 없으면 primary의 전송이다. */
  server?: string
}

export type ConflictDecision = 'overwrite' | 'skip' | 'rename' | 'newer'

export interface TransferSendRequest {
  direction: TransferDirection
  /** 다운로드면 원격 경로, 업로드면 로컬 경로. 파일·폴더 섞여도 된다 */
  sources: string[]
  /** 다운로드면 로컬 폴더, 업로드면 원격 폴더 */
  destDir: string
  /** 대상 경로 → 결정. 충돌마다 하나. 없으면 충돌이 있을 때 아무것도 넣지 않는다 */
  decisions?: Record<string, ConflictDecision>
}

export interface TransferConflict {
  /** 대상 경로(결정 키) */
  target: string
  source: string
  name: string
  incoming: { size: number; modifiedAt: string }
  existing: { size: number; modifiedAt: string }
  /** 같은 쪽 보내기에서 어느 한쪽이 폴더다: 둘 다 두기·건너뛰기만 묻는다(D32) */
  folder?: boolean
}

export interface TransferSendResult {
  /** 큐에 넣었으면 배치 id(강제 배치). 충돌로 멈췄으면 없음 */
  batchId?: string
  ids: string[]
  skipped: Array<{ path: string; reason: string }>
  /** 결정이 없는 충돌. 비어 있지 않으면 ids도 비어 있다 */
  conflicts: TransferConflict[]
  totalBytes: number
}
