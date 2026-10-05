import { useEffect } from 'react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { localSyncAction, remoteSyncAction, type SyncAction } from '@renderer/lib/agentSync'
import { emptyDraft, findSaved, serverAddress } from '@renderer/lib/serverAddress'
import type { AgentSessionEvent, LocalChangeEvent } from '@shared/types/agent'
import type { FtpMutationEvent } from '@shared/types/ftp'

/** 변경이 몰려 와도(폴더 업로드·삭제) 목록은 조용해진 뒤 한 번만 다시 읽는다. */
export const AGENT_SYNC_DEBOUNCE_MS = 300

/** 마지막 항목 뒤 `AGENT_SYNC_DEBOUNCE_MS` 동안 더 오지 않으면 모은 것을 한꺼번에 넘긴다. */
function debounced<T>(flush: (items: T[]) => void): { push: (item: T) => void; stop: () => void } {
  let items: T[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    push: (item) => {
      items.push(item)
      clearTimeout(timer)
      timer = setTimeout(() => {
        const batch = items
        items = []
        flush(batch)
      }, AGENT_SYNC_DEBOUNCE_MS)
    },
    stop: () => clearTimeout(timer)
  }
}

function apply(
  action: SyncAction,
  pane: { navigateTo: (path: string) => Promise<void>; refresh: () => Promise<void> }
): void {
  if (action?.kind === 'navigate') void pane.navigateTo(action.path)
  else if (action?.kind === 'refresh') void pane.refresh()
}

/** 에이전트가 연 세션을 GUI가 보여 준다(G3). 툴바는 그 서버, 원격 패널은 그 폴더. */
async function followSession(event: AgentSessionEvent): Promise<void> {
  const ftp = useFtpStore.getState()
  if (event.status === 'disconnected') {
    ftp.adoptSession({ status: 'disconnected' })
    return
  }
  if (event.status !== 'connected') return
  ftp.adoptSession({ status: 'connected', host: event.host, port: event.port })
  const listing = ftp.navigateTo(event.path ?? '/')

  const servers = useServerStore.getState()
  await servers.loadServers()
  // 서버 목록을 받는 사이 사용자가 연결을 시작했으면 툴바를 빼앗지 않는다.
  if (useServerStore.getState().connecting) return
  const all = useServerStore.getState().servers
  const saved =
    all.find((s) => s.id === event.serverId) ??
    (event.host ? findSaved(all, event.host, event.port ?? 21) : undefined)
  if (saved) {
    servers.select(saved)
  } else {
    const draft = {
      ...emptyDraft(),
      host: event.host ?? '',
      port: String(event.port ?? 21),
      username: event.user ?? ''
    }
    useServerStore.setState({ draft, address: serverAddress(draft), error: '' })
  }
  await listing
}

/**
 * main이 알리는 변경을 GUI에 반영한다(handoff agent-operations §2.5 G1–G3):
 * `ftp:remoteChanged`·`local:changed`는 보고 있는 폴더를 새로 고치거나 벗어나게 하고,
 * `agent:session`은 에이전트가 연결·해제한 세션을 툴바와 원격 패널에 보여 준다.
 */
export function useAgentSync(): void {
  useEffect(() => {
    const remote = debounced<FtpMutationEvent>((events) => {
      const ftp = useFtpStore.getState()
      if (ftp.connectionStatus !== 'connected') return
      apply(remoteSyncAction(events, ftp.currentPath), ftp)
    })
    const local = debounced<string>((paths) => {
      const pane = useLocalFsStore.getState()
      if (!pane.currentPath) return
      apply(localSyncAction(paths, pane.currentPath), pane)
    })

    const unsubscribers = [
      window.api.on('ftp:remoteChanged', (...args: unknown[]) => {
        remote.push(args[0] as FtpMutationEvent)
      }),
      window.api.on('local:changed', (...args: unknown[]) => {
        for (const path of (args[0] as LocalChangeEvent).paths) local.push(path)
      }),
      window.api.on('agent:session', (...args: unknown[]) => {
        // 사용자가 직접 연결하는 중이면 그 흐름이 툴바와 패널을 정한다.
        if (useServerStore.getState().connecting) return
        void followSession(args[0] as AgentSessionEvent)
      })
    ]
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
      remote.stop()
      local.stop()
    }
  }, [])
}
