import type { FtpMutationEvent } from '@shared/types/ftp'
import type { AgentSessionEvent, LocalChangeEvent } from '@shared/types/agent'

/**
 * main → 렌더러 GUI 동기화 이벤트(docs/handoff/agent-operations.md §2.5 G1–G4).
 * 창이 없거나 파괴되었으면 보내지 않는다(G4).
 */
export interface AgentEventSink {
  /** G1: `ftp:remoteChanged`. GUI가 시작한 변경도 포함해 FtpConnectionManager의 mutation을 모두 전달한다. */
  remoteChanged(event: FtpMutationEvent): void
  /** G2: `local:changed`. 에이전트 도구가 바꾼 로컬 경로. */
  localChanged(event: LocalChangeEvent): void
  /** G3: `agent:session`. 에이전트가 연결하거나 해제했다. */
  session(event: AgentSessionEvent): void
}

/** BrowserWindow 중 이벤트를 보내는 데 쓰는 부분 */
export interface AgentEventWindow {
  isDestroyed(): boolean
  webContents: { send(channel: string, ...args: unknown[]): void }
}

export function createAgentEventSink(
  getWindow: () => AgentEventWindow | null | undefined
): AgentEventSink {
  const send = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(channel, payload)
  }
  return {
    remoteChanged: (event) => send('ftp:remoteChanged', event),
    localChanged: (event) => send('local:changed', event),
    session: (event) => send('agent:session', event)
  }
}

/** FtpConnectionManager의 `mutation`을 sink로 넘긴다. 돌려주는 함수로 떼어 낸다. */
export function attachRemoteChangeForwarding(
  manager: {
    on(event: 'mutation', listener: (event: FtpMutationEvent) => void): unknown
    off(event: 'mutation', listener: (event: FtpMutationEvent) => void): unknown
  },
  sink: Pick<AgentEventSink, 'remoteChanged'>
): () => void {
  const forward = (event: FtpMutationEvent): void => sink.remoteChanged(event)
  manager.on('mutation', forward)
  return () => {
    manager.off('mutation', forward)
  }
}
