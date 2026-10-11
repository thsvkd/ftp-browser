import { useEffect } from 'react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useListingStore } from '@renderer/stores/useListingStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { connectedServer } from '@renderer/lib/sendItems'
import { useServerStore } from '@renderer/stores/useServerStore'
import { emptyDraft, findSaved, serverAddress } from '@renderer/lib/serverAddress'
import type { AgentSessionEvent } from '@shared/types/mcp'
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

/** POSIX 원격 경로의 부모. 원격 이름에는 `\`가 들어갈 수 있으므로 `/`만 구분자다. */
function remoteParent(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut <= 0 ? '/' : trimmed.slice(0, cut)
}

/**
 * 원격 변경 묶음을 탭과 목록에 반영한다(함정 12). 지워지거나 옮겨진 폴더(또는 그 위)를 보는 원격 탭은
 * 활성 여부와 관계없이 그 부모로 가고, 바뀐 폴더의 목록은 읽은 적이 있으면 다시 읽는다.
 */
function syncRemote(events: FtpMutationEvent[]): void {
  const server = connectedServer(useFtpStore.getState())
  if (!server) return
  const tabs = useTabsStore.getState()
  const dirs = new Set<string>()
  for (const { kind, remotePath, newPath } of events) {
    dirs.add(remoteParent(remotePath))
    if (newPath) dirs.add(remoteParent(newPath))
    if (kind !== 'delete' && kind !== 'rename') continue
    for (const { id, loc } of useTabsStore.getState().tabs) {
      if (loc.side !== 'remote' || (loc.server && loc.server !== server)) continue
      if (loc.path === remotePath || loc.path.startsWith(`${remotePath}/`))
        tabs.navigate({ ...loc, path: remoteParent(remotePath) }, { tabId: id })
    }
  }
  for (const dir of dirs) useListingStore.getState().invalidate('remote', server, dir)
}

/**
 * 에이전트가 연 세션을 GUI가 보여 준다. 툴바는 그 서버, 원격 탭 하나는 그 폴더(D3). 사용자의 화면을
 * 빼앗지 않도록 활성 탭은 바꾸지 않는다.
 */
async function followSession(event: AgentSessionEvent): Promise<void> {
  const ftp = useFtpStore.getState()
  if (event.status === 'disconnected') {
    ftp.adoptSession({ status: 'disconnected' })
    return
  }
  if (event.status !== 'connected') return
  ftp.adoptSession({ status: 'connected', host: event.host, port: event.port, user: event.user })
  const server = connectedServer(useFtpStore.getState())
  if (server) useTabsStore.getState().adoptRemote(server, event.path ?? '/', { activate: false })

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
}

/**
 * main이 알리는 변경을 GUI에 반영한다(handoff agent-access K5): `ftp:remoteChanged`는 원격 목록을
 * 새로 고치고 지워진 폴더를 보는 탭을 벗어나게 하며, `agent:session`은 에이전트가 연결·해제한 세션을
 * 툴바와 원격 탭에 보여 준다.
 */
export function useAgentSync(): void {
  useEffect(() => {
    const remote = debounced<FtpMutationEvent>(syncRemote)

    const unsubscribers = [
      window.api.on('ftp:remoteChanged', (...args: unknown[]) => {
        remote.push(args[0] as FtpMutationEvent)
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
    }
  }, [])
}
