import { EventEmitter } from 'events'
import type { ConnectionRegistry, FtpSession } from '../ftp/ConnectionRegistry'
import type { TransferJob, TransferUpdate } from '@shared/types/transfer'

/**
 * 연결마다 따로인 전송 큐들을 하나로 보인다(multi-connection MC6). 목록은 세션을 만든 순서로 이어 붙이고,
 * id로 오는 명령은 그 작업을 가진 큐로만 보낸다. 세션 큐들의 `queue:updated`를 한 줄기로 다시 낸다.
 * 작업 id는 전역 UUID라 어느 큐의 것인지 id만으로 찾는다.
 */
export class TransferHub extends EventEmitter {
  constructor(private registry: ConnectionRegistry) {
    super()
    for (const session of registry.sessions()) this.watch(session)
    registry.on('session', (session: FtpSession) => this.watch(session))
  }

  private watch(session: FtpSession): void {
    session.queue.on('queue:updated', (update: TransferUpdate) => {
      this.emit('queue:updated', update)
    })
  }

  getAll(): TransferJob[] {
    return this.registry.sessions().flatMap((session) => session.queue.getAll())
  }

  cancel(id: string): void {
    this.owners().get(id)?.queue.cancel(id)
  }

  /** 큐마다 한 번, 그 큐의 id만 넘긴다(한 배치의 업로드가 사이 폴더 메모 하나를 함께 쓴다). 모르는 id는 무시. */
  retry(ids: string[]): void {
    const owners = this.owners()
    const byQueue = new Map<FtpSession, string[]>()
    for (const id of ids) {
      const owner = owners.get(id)
      if (!owner) continue
      const group = byQueue.get(owner) ?? []
      group.push(id)
      byQueue.set(owner, group)
    }
    for (const [session, group] of byQueue) session.queue.retry(group)
  }

  clearCompleted(): void {
    for (const session of this.registry.sessions()) session.queue.clearCompleted()
  }

  /** 작업 id → 그 작업을 가진 세션 */
  private owners(): Map<string, FtpSession> {
    const owners = new Map<string, FtpSession>()
    for (const session of this.registry.sessions()) {
      for (const job of session.queue.getAll()) owners.set(job.id, session)
    }
    return owners
  }
}
