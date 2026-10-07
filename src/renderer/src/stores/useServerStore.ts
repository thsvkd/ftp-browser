import { create } from 'zustand'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { confirmDialog } from '@renderer/stores/useConfirmStore'
import {
  emptyDraft,
  findSaved,
  isValidPort,
  parseServerAddress,
  resolveDraft,
  serverAddress,
  serverLabel,
  stripPassword,
  toDraft,
  type ServerDraft
} from '@renderer/lib/serverAddress'
import { t } from '@renderer/i18n'
import {
  isValidMaxTransfers,
  type FtpServer,
  type FtpServerInput,
  type RecentPath
} from '@shared/types/ftp'
import { ErrorCode, type IpcResult } from '@shared/types/ipc'

interface ServerStore {
  /** Saved servers, most recently connected first. */
  servers: FtpServer[]
  /** The server in the toolbar: what Connect uses, and what the connected toolbar shows. */
  draft: ServerDraft
  /** Text in the address box, kept as typed. */
  address: string
  connecting: boolean
  error: string

  /** `prefill` puts the most recent server into an empty toolbar (startup). */
  loadServers: (prefill?: boolean) => Promise<void>
  select: (server: FtpServer) => void
  setAddress: (text: string) => void
  patch: (fields: Partial<ServerDraft>) => void
  clearError: () => void
  /** Connects to `draft` (default: the toolbar's) and makes it the toolbar's server. */
  connect: (draft?: ServerDraft) => Promise<boolean>
  cancel: () => void
  save: (draft: ServerDraft) => Promise<IpcResult<FtpServer>>
  /** Asks first; resolves true when the server was deleted. */
  remove: (server: FtpServer) => Promise<boolean>
}

/** Bumped by every connect and cancel, so a late result of an abandoned attempt is ignored. */
let connectAttempt = 0

/** The folder last listed on this server, or '/' when there is none (or it can't be read). */
async function lastVisitedPath(server: { host: string; port: number }): Promise<string> {
  try {
    const result = await window.api.invoke<IpcResult<RecentPath[]>>(
      'ftp:getRecentPaths',
      server.host,
      server.port
    )
    return (result.success && result.data[0]?.path) || '/'
  } catch (err) {
    console.warn('[useServerStore] Failed to load the last folder:', err)
    return '/'
  }
}

export const useServerStore = create<ServerStore>((set, get) => ({
  servers: [],
  draft: emptyDraft(),
  address: '',
  connecting: false,
  error: '',

  loadServers: async (prefill = false) => {
    try {
      const result = await window.api.invoke<IpcResult<FtpServer[]>>('ftp:getRecentServers')
      if (!result.success) return
      set({ servers: result.data })
      if (prefill && result.data[0] && !get().draft.host) get().select(result.data[0])
    } catch (err) {
      console.warn('[useServerStore] Failed to load saved servers:', err)
    }
  },

  select: (server) => {
    // 연결 중에는 툴바의 서버를 바꾸지 않는다(드롭다운·칩 클릭 무시).
    if (get().connecting) return
    set({ draft: toDraft(server), address: serverAddress(server), error: '' })
  },

  setAddress: (text) => {
    if (get().connecting) return
    const p = parseServerAddress(text)
    const { draft, servers } = get()
    const match = findSaved(servers, p.host, p.port ?? 21)
    // 주소가 저장된 서버와 맞으면 그 서버로 돌아가고, 선택했던 서버에서 벗어나면
    // 새 서버가 된다. 그때 별칭·비밀번호·시작 폴더는 끌고 가지 않는다.
    const base = match
      ? match.id === draft.id
        ? draft
        : toDraft(match)
      : draft.id !== undefined
        ? { ...emptyDraft(), secure: draft.secure }
        : draft
    // 주소에 `user@`를 적지 않으면 저장된 서버의 계정을 그대로 쓴다(익명은 `anonymous@`로 적는다).
    // 다른 사용자를 적으면 저장된 비밀번호를 그 사용자에게 넘기지 않는다. 주소에 적은 비밀번호는
    // 저장된 비밀번호를 대신한다.
    const username = p.user ?? match?.username ?? ''
    const sameAsBase = username === base.username
    const password = p.password ?? (sameAsBase ? base.password : '')
    const savedPassword =
      p.password === undefined &&
      (sameAsBase
        ? base.savedPassword
        : match !== undefined && username === match.username && match.hasPassword)
    set({
      // 비밀번호는 비밀번호 칸에만 둔다.
      address: p.password !== undefined ? stripPassword(text) : text,
      error: '',
      draft: {
        ...base,
        // 저장된 서버는 저장된 표기 그대로(예전 행의 'NAS.local') 써야 같은 행으로 이어진다.
        host: match?.host ?? p.host,
        port: String(p.port ?? 21),
        username,
        password,
        savedPassword,
        secure: p.secure || base.secure,
        // 주소에 폴더가 없으면 마지막으로 있던 폴더에서 연다.
        path: p.path ?? ''
      }
    })
  },

  patch: (fields) => set({ draft: { ...get().draft, ...fields }, error: '' }),

  clearError: () => set({ error: '' }),

  connect: async (draft = get().draft) => {
    if (get().connecting) return false
    const { server, path } = resolveDraft(draft)
    if (!isValidPort(server.port)) {
      set({ error: t('servers.invalidPort') })
      return false
    }
    if (!isValidMaxTransfers(server.maxTransfers)) {
      set({ error: t('servers.invalidMaxTransfers') })
      return false
    }
    const attempt = ++connectAttempt
    set({
      draft,
      address: draft === get().draft ? get().address : serverAddress(draft),
      connecting: true,
      error: ''
    })
    const ftp = useFtpStore.getState()
    // 연결된 채로 다른 서버를 고르면 먼저 끊는다.
    if (ftp.connectionStatus === 'connected') await ftp.disconnect()
    if (attempt !== connectAttempt) return false

    // 시작 폴더를 따로 정하지 않았으면 이 서버에서 마지막으로 있던 폴더로 연다.
    const startPath = path ?? (draft.path.trim() || (await lastVisitedPath(server)))
    if (attempt !== connectAttempt) return false

    // 저장된 서버를 저장된 계정으로 연결할 때만 id를 보낸다. 그래야 main이 그 서버의
    // 로그인을 고친다. 다른 사용자·익명으로 접속하면 저장된 로그인은 그대로 두고 시각만 찍는다.
    const savedRow = get().servers.find((s) => s.id === draft.id)
    const sameAccount = savedRow !== undefined && savedRow.username === server.username
    // 입력한 비밀번호가 없으면 저장된 비밀번호를 서버 id로 가리킨다. main이 읽어 로그인한다.
    const savedPasswordOf = !server.password && draft.savedPassword ? draft.id : undefined
    const ok = await ftp.connect(
      {
        ...(sameAccount && { id: savedRow.id }),
        name: server.name,
        host: server.host,
        port: server.port,
        user: server.username || 'anonymous',
        ...(savedPasswordOf !== undefined
          ? { savedPasswordOf }
          : { password: server.password || 'anonymous@' }),
        secure: server.secure,
        maxTransfers: server.maxTransfers
      },
      startPath
    )
    if (attempt !== connectAttempt) return false
    if (!ok) {
      set({ connecting: false, error: useFtpStore.getState().error || t('connect.failed') })
      return false
    }
    set({ connecting: false })
    // 연결하면 main이 서버를 저장(또는 갱신)한다. 툴바가 저장된 서버를 가리키게 한다.
    await get().loadServers()
    // 목록을 받는 사이 다른 연결이 시작됐으면 그쪽 초안을 덮어쓰지 않는다.
    if (attempt !== connectAttempt) return true
    // 다른 계정으로 연결했으면 툴바를 저장된 계정으로 되돌리지 않는다(연결한 그대로 둔다).
    if (draft.id !== undefined && !sameAccount) return true
    const saved = findSaved(get().servers, server.host, server.port)
    // 주소칸에서 폴더가 빠지므로 시작 폴더도 비운다. 다음 연결은 마지막으로 있던 폴더에서 연다.
    if (saved) set({ draft: toDraft(saved), address: serverAddress(saved) })
    return true
  },

  cancel: () => {
    if (!get().connecting) return
    connectAttempt++
    set({ connecting: false })
    void useFtpStore.getState().disconnect()
  },

  save: async (draft) => {
    const { password, ...server } = resolveDraft(draft).server
    if (!isValidPort(server.port)) {
      return { success: false, error: t('servers.invalidPort'), code: ErrorCode.INVALID_PORT }
    }
    if (!isValidMaxTransfers(server.maxTransfers)) {
      return {
        success: false,
        error: t('servers.invalidMaxTransfers'),
        code: ErrorCode.INVALID_MAX_TRANSFERS
      }
    }
    // 비밀번호: 입력했으면 그 값으로 바꾸고, 저장된 것을 쓰는 중이면 빼서 그대로 두며,
    // 지웠으면(또는 새 서버에 없으면) ''로 지운다.
    const keep = !password && draft.savedPassword && draft.id !== undefined
    const input: FtpServerInput = { ...server, ...(!keep && { password }) }
    const result = await window.api.invoke<IpcResult<FtpServer>>('ftp:saveServer', input)
    if (!result.success) return result
    await get().loadServers()
    // 툴바가 같은 서버를 가리키고 있으면 저장한 내용(별칭 등)을 반영한다.
    const current = get().draft
    const saved = result.data
    const same =
      current.id === saved.id ||
      (current.id === undefined &&
        findSaved([saved], current.host, Number(current.port) || 21) !== undefined)
    if (same && !get().connecting) {
      set({ draft: toDraft(saved, current.path), address: serverAddress(saved) })
    }
    return result
  },

  remove: async (server) => {
    const confirmed = await confirmDialog({
      title: t('servers.deleteTitle', { name: serverLabel(server) }),
      message: t('servers.deleteMessage'),
      confirmLabel: t('common.delete'),
      destructive: true
    })
    if (!confirmed) return false
    const result = await window.api.invoke<IpcResult<void>>('ftp:deleteServer', server.id)
    if (!result.success) return false
    const { draft, servers } = get()
    set({
      servers: servers.filter((s) => s.id !== server.id),
      // 툴바의 서버를 지웠으면 주소는 두고 저장 안 된 새 서버로 돌린다.
      // 그 서버의 저장된 비밀번호도 함께 지워졌다.
      ...(draft.id === server.id && {
        draft: { ...draft, id: undefined, name: '', savedPassword: false }
      })
    })
    return true
  }
}))
