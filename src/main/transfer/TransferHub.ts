import { EventEmitter } from 'events'
import type { ConnectionRegistry, FtpSession } from '../ftp/ConnectionRegistry'
import { RelayLane, type RelayOptions } from './RelayLane'
import type { ConnKey } from '@shared/connKey'
import type { RelayEnqueueItem, TransferJob, TransferUpdate } from '@shared/types/transfer'

/**
 * 연결마다 따로인 전송 큐들과 서버 간 작업(RelayLane)을 하나로 보인다(multi-connection MC6). 목록은 세션을 만든
 * 순서로 이어 붙이고 서버 간 작업을 뒤에 붙인다. id로 오는 명령은 그 작업을 가진 큐·레인으로만 보낸다. 큐들과
 * 레인의 `queue:updated`를 한 줄기로 다시 낸다. 작업 id는 전역 UUID라 어느 것의 작업인지 id만으로 찾는다.
 */
export class TransferHub extends EventEmitter {
  private lane: RelayLane

  constructor(
    private registry: ConnectionRegistry,
    relay?: Partial<RelayOptions>
  ) {
    super()
    this.lane = new RelayLane(registry, relay)
    this.lane.on('queue:updated', (update: TransferUpdate) => this.emit('queue:updated', update))
    for (const session of registry.sessions()) this.watch(session)
    registry.on('session', (session: FtpSession) => this.watch(session))
  }

  private watch(session: FtpSession): void {
    session.queue.on('queue:updated', (update: TransferUpdate) => {
      this.emit('queue:updated', update)
    })
  }

  getAll(): TransferJob[] {
    return [
      ...this.registry.sessions().flatMap((session) => session.queue.getAll()),
      ...this.lane.getAll()
    ]
  }

  cancel(id: string): void {
    if (this.lane.has(id)) this.lane.cancel(id)
    else this.owners().get(id)?.queue.cancel(id)
  }

  /** 여러 작업을 취소한다. 큰 배치도 목록을 한 번만 훑는다(agent-activity A8). 모르는 id는 무시. */
  cancelMany(ids: string[]): void {
    const owners = this.owners()
    for (const id of ids) {
      if (this.lane.has(id)) this.lane.cancel(id)
      else owners.get(id)?.queue.cancel(id)
    }
  }

  /**
   * 큐마다 한 번, 그 큐의 id만 넘긴다(한 배치의 업로드가 사이 폴더 메모 하나를 함께 쓴다). 서버 간 작업은 레인에
   * 한 번. 모르는 id는 무시.
   */
  retry(ids: string[]): void {
    const relayed = ids.filter((id) => this.lane.has(id))
    if (relayed.length > 0) this.lane.retry(relayed)
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
    this.lane.clearCompleted()
  }

  /** 서버 간 작업을 강제 배치로 넣는다(MC23). 어느 세션 큐에도 넣지 않는다(MC24). */
  enqueueRelay(src: ConnKey, dst: ConnKey, items: RelayEnqueueItem[], dirs: string[]): string[] {
    return this.lane.enqueue(src, dst, items, dirs)
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
