import type Database from 'better-sqlite3'
import type { FtpConnectionManager } from '../../ftp/FtpConnectionManager'
import type { FtpFileOperations } from '../../ftp/FtpFileOperations'
import type { TransferQueue } from '../../transfer/TransferQueue'
import type { OperationManager } from '../../operation/OperationManager'
import type { LocalFileSystem } from '../../local/LocalFileSystem'
import type { AgentEventSink } from '../events'
import type { PasswordVault } from '../../db/passwordVault'
import type { AgentServices } from '../types'
import type { TransferUpdate } from '@shared/types/transfer'
import type { OperationJob } from '@shared/types/operation'
import { createSessionService, createServersService } from './session'
import { createRemoteService } from './remote'
import { createLocalService } from './local'
import { createTransfersService } from './transfers'
import { createJobsService } from './jobs'

/** EventEmitter 중 서비스가 구독하는 이벤트 하나 */
interface Listenable<E extends string, T> {
  on(event: E, listener: (payload: T) => void): unknown
  off(event: E, listener: (payload: T) => void): unknown
}

/** 서비스가 쓰는 앱 인스턴스의 좁은 면. 테스트는 가짜를 넣는다. */
export interface AgentServiceDeps {
  db: Database.Database
  ftp: Pick<
    FtpConnectionManager,
    | 'connect'
    | 'disconnect'
    | 'list'
    | 'isConnected'
    | 'getStatus'
    | 'getHost'
    | 'getPort'
    | 'getUser'
    | 'getConnectGeneration'
    | 'createSecondaryClient'
    | 'runOnMainClient'
  >
  fileOps: Pick<FtpFileOperations, 'mkdir' | 'rename' | 'deleteFile' | 'deleteDirectory'>
  queue: Pick<TransferQueue, 'enqueueBatch' | 'cancel' | 'clearCompleted' | 'getAll'> &
    Listenable<'queue:updated', TransferUpdate>
  operations: Pick<
    OperationManager,
    | 'create'
    | 'progress'
    | 'complete'
    | 'fail'
    | 'requestCancel'
    | 'isCancelled'
    | 'markCancelled'
    | 'clearFinished'
    | 'getAll'
  > &
    Listenable<'operation:updated', OperationJob[]>
  localFs: Pick<LocalFileSystem, 'list' | 'mkdir' | 'rename' | 'delete' | 'collectFiles'>
  /** local:changed(G2), agent:session(G3). ftp:remoteChanged는 attachRemoteChangeForwarding이 맡는다. */
  events: Pick<AgentEventSink, 'localChanged' | 'session'>
  /** 저장된 비밀번호를 연결할 때만 main 안에서 푼다(saved-password-encryption E13) */
  passwords: Pick<PasswordVault, 'reveal'>
  /** 로컬 파일 이름 규칙(toLocalFileName). 기본은 process.platform. */
  platform?: string
}

/**
 * AgentServices(src/main/agent/types.ts)의 구현. MCP·위험 등급·확인은 모른다(§2.1 S1).
 * 전송·작업 알림을 구독하므로 앱에서 한 번만 만든다.
 */
export function createAgentServices(deps: AgentServiceDeps): AgentServices {
  const servers = createServersService(deps)
  return {
    session: createSessionService(deps, servers),
    servers,
    remote: createRemoteService(deps),
    local: createLocalService(deps),
    transfers: createTransfersService(deps),
    jobs: createJobsService(deps)
  }
}
