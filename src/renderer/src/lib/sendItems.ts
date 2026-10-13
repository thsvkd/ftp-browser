/**
 * 보내기 실행: 다른 쪽이면 `transfer:send`, 같은 쪽이면 원격 이동(`ftp:rename`)·로컬 복사
 * (`local:copyFiles`, D15). 끌어 놓기·선반·"보내기 ▸"·OS 드롭이 모두 여기로 온다.
 */
import { toast } from 'sonner'
import { t } from '@renderer/i18n'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { fetchEntries, useListingStore } from '@renderer/stores/useListingStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import {
  fromLocalEntry,
  joinPath,
  locKey,
  sameLoc,
  type ExplorerEntry,
  type Loc
} from './explorerEntry'
import { flyTo } from './flyTo'
import { pathCrumbs } from './pathCrumbs'
import { currentPlatform } from './platform'
import { moveRemoteFiles } from './remoteDrop'
import { planSameSide, type SameSideItem, type SameSideOp } from './sameSidePlan'
import { planSend, type SendConnection, type SendPlan } from './sendPlan'
import type { IpcResult } from '@shared/types/ipc'
import type { FtpServer } from '@shared/types/ftp'
import type { LocalFileEntry, LocalPlaces } from '@shared/types/local'

interface FtpConnectionFields {
  connectionStatus: string
  host: string
  port: number
  /** 연결한 사용자 이름(D1). 없으면 빈 이름으로 키를 만든다. */
  username?: string
}

/** 지금 연결의 서버 키 `"user@host:port"`(D1). 연결돼 있지 않으면 null. */
export function connectedServer(s: FtpConnectionFields): string | null {
  return s.connectionStatus === 'connected' ? `${s.username ?? ''}@${s.host}:${s.port}` : null
}

export function currentConnection(): SendConnection {
  const server = connectedServer(useFtpStore.getState())
  return { connected: server !== null, server }
}

/** 렌더 중에 쓰는 연결. 문자열 하나를 구독하므로 진행률 갱신에는 다시 그려지지 않는다. */
export function useConnection(): SendConnection {
  const server = useFtpStore(connectedServer)
  return { connected: server !== null, server }
}

/** 활성 탭의 폴더를 다시 읽는다(툴바 새로 고침, 창 어디서나 F5·Ctrl+R). 다른 서버의 탭은 읽지 않는다(D2). */
export function reloadActiveTab(): void {
  const { tabs, activeId } = useTabsStore.getState()
  const loc = tabs.find((tab) => tab.id === activeId)?.loc
  if (!loc) return
  const { server } = currentConnection()
  if (loc.side === 'remote' && (!server || (loc.server && loc.server !== server))) return
  void useListingStore.getState().load(loc)
}

/** 출처 이름: 내 PC 또는 서버의 `host:port`. */
export function sourceLabel(loc: Pick<Loc, 'side' | 'server'>): string {
  if (loc.side === 'local') return t('sidebar.thisPc')
  return loc.server ? loc.server.slice(loc.server.lastIndexOf('@') + 1) : t('explorer.remote')
}

/** 위치의 짧은 이름: 마지막 폴더 이름. 루트면 드라이브 이름이나 "{출처} 루트". */
export function locLabel(loc: Loc): string {
  const crumbs = pathCrumbs(loc.side, loc.path)
  if (crumbs.length > 1) return crumbs[crumbs.length - 1].name
  const drive = loc.side === 'local' ? /^([A-Za-z]:)/.exec(loc.path) : null
  return drive
    ? t('place.drive', { name: drive[1] })
    : t('place.root', { source: sourceLabel(loc) })
}

/** "Download 3 · Move 2" — 그 계획이 무엇을 하는지. */
export function planVerb(plan: SendPlan): string {
  const parts: string[] = []
  if (plan.direction) parts.push(t(`send.${plan.direction}`, { count: plan.transfer.length }))
  if (plan.sameSideVerb) parts.push(t(`send.${plan.sameSideVerb}`, { count: plan.sameSide.length }))
  return parts.join(' · ')
}

/** 활동 팝오버의 이름표: 첫 이름, 여럿이면 "{이름} and N more". */
function batchLabel(names: readonly string[]): string {
  return names.length > 1
    ? t('activity.labelMany', { name: names[0], count: names.length - 1 })
    : (names[0] ?? '')
}

const baseName = (path: string): string =>
  path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

/**
 * 같은 쪽 보내기의 충돌을 묻는다(D32): 대상 폴더를 한 번 읽어 맨 위 이름을 견주고, 겹치면 충돌
 * 시트에 묻는다. 실행할 동작을 돌려주고, 취소하거나 대상 폴더를 읽지 못하면 null.
 */
async function sameSideOps(
  verb: 'move' | 'copy',
  items: readonly SameSideItem[],
  dest: Loc
): Promise<SameSideOp[] | null> {
  const listing = await fetchEntries(dest)
  if (!listing.success) {
    toast.error(t('toast.sendFailed'), { description: listing.error })
    return null
  }
  const platform = currentPlatform()
  const first = planSameSide(items, listing.data, dest, platform)
  if (!first.conflicts.length) return first.ops
  const decisions = await useTransferStore.getState().askConflicts(verb, first.conflicts)
  return decisions && planSameSide(items, listing.data, dest, platform, decisions).ops
}

async function moveRemote(items: readonly SameSideItem[], dest: Loc): Promise<boolean> {
  const ops = await sameSideOps('move', items, dest)
  if (!ops) return false
  const replace = new Set(
    ops.filter((o) => o.overwrite).map((o) => joinPath('remote', dest.path, o.name))
  )
  return moveRemoteFiles(
    ops.map((o) => ({ remotePath: o.source, fileName: o.name, size: 0 })),
    dest.path,
    replace
  )
}

async function copyLocal(items: readonly SameSideItem[], dest: Loc): Promise<boolean> {
  try {
    const ops = await sameSideOps('copy', items, dest)
    if (!ops) return false
    if (!ops.length) return true
    const r = await window.api.invoke<IpcResult<void>>(
      'local:copyFiles',
      ops.map((o) => o.source),
      dest.path,
      ops.map((o) => o.name)
    )
    if (!r.success) toast.error(t('toast.sendFailed'), { description: r.error })
    return r.success
  } catch (err) {
    toast.error(t('toast.sendFailed'), {
      description: err instanceof Error ? err.message : String(err)
    })
    return false
  } finally {
    useListingStore.getState().invalidate('local', undefined, dest.path)
  }
}

function transfer(direction: 'upload' | 'download', paths: string[], dest: Loc): Promise<boolean> {
  return useTransferStore
    .getState()
    .send(
      { direction, sources: paths, destDir: dest.path },
      { label: batchLabel(paths.map(baseName)), to: dest }
    )
    .then((r) => r !== null)
}

/** 검사를 마친 계획을 실행한다. 시작에 성공한 부분(전송·같은 쪽 동작)의 항목을 돌려준다. */
async function runParts(plan: SendPlan, dest: Loc): Promise<ExplorerEntry[]> {
  const parts: Array<[ExplorerEntry[], Promise<boolean>]> = []
  if (plan.direction)
    parts.push([
      plan.transfer,
      transfer(
        plan.direction,
        plan.transfer.map((e) => e.path),
        dest
      )
    ])
  if (plan.sameSideVerb === 'move') parts.push([plan.sameSide, moveRemote(plan.sameSide, dest)])
  if (plan.sameSideVerb === 'copy') parts.push([plan.sameSide, copyLocal(plan.sameSide, dest)])
  const oks = await Promise.all(parts.map(([, run]) => run))
  return parts.flatMap(([entries], i) => (oks[i] ? entries : []))
}

/** 검사를 마친 계획을 실행한다. 전송·같은 쪽 동작이 모두 시작되면 true. */
export async function runPlan(plan: SendPlan, dest: Loc): Promise<boolean> {
  const started = await runParts(plan, dest)
  return started.length === plan.transfer.length + plan.sameSide.length
}

/** 항목들을 `dest`로 보낸다. 막히면 사유를 토스트로 알리고 false. */
export async function sendItems(items: readonly ExplorerEntry[], dest: Loc): Promise<boolean> {
  const plan = planSend(items, dest, currentConnection())
  if (plan.invalid) {
    toast.error(t(plan.invalid))
    return false
  }
  return runPlan(plan, dest)
}

/**
 * 선반의 모든 항목을 `dest`에 내려놓는다. 더미가 활동 알약(`[data-activity-target]`)으로 날아가고,
 * 시작에 성공하면 보낸 항목만 선반에서 뺀다(그사이 더 담은 것은 남는다).
 */
// 내려놓기는 LIST 왕복이나 충돌 시트를 기다리는 동안 선반을 그대로 두므로, 그사이 다시 누르면 같은 항목을 또 보낸다
let dropping = false

export async function dropShelf(dest: Loc): Promise<boolean> {
  if (dropping) return false
  dropping = true
  try {
    return await dropShelfOnce(dest)
  } finally {
    dropping = false
  }
}

async function dropShelfOnce(dest: Loc): Promise<boolean> {
  const items = useShelfStore.getState().items.map((i) => i.entry)
  if (!items.length) {
    toast(t('toast.shelfEmpty'))
    return false
  }
  const plan = planSend(items, dest, currentConnection())
  if (plan.invalid) {
    toast.error(t(plan.invalid))
    return false
  }
  const cards = [...document.querySelectorAll('[data-shelf-stack] [data-card]')].map((c) => ({
    rect: c.getBoundingClientRect(),
    src: c.querySelector('img')?.getAttribute('src') ?? null
  }))
  flyTo(cards, document.querySelector('[data-activity-target]'))
  // 모두 시작하면 선반을 비운다(이미 그 폴더에 있던 항목 포함). 일부가 실패하면 시작한 부분의 항목만 뺀다
  const started = await runParts(plan, dest)
  const ok = started.length === plan.transfer.length + plan.sameSide.length
  useShelfStore.getState().remove((ok ? items : started).map(locKey))
  return ok
}

/** OS에서 끌어 온 파일: 원격 위치면 업로드, 로컬 위치면 복사(지금 로컬 패널과 같다). */
export async function dropOsFiles(files: readonly File[], dest: Loc): Promise<boolean> {
  // ponytail: File은 폴더인지 알려 주지 않는다. 크기 0·형식 없음은 폴더일 수 있어 폴더로 본다(충돌 시
  // 둘 다 두기·건너뛰기만, D32). 빈 파일도 그렇게 묻는다. 틀리면 부모 폴더를 local:list로 읽는다
  const items = files.flatMap((f): SameSideItem[] => {
    const path = window.api.getPathForFile(f)
    if (!path) return []
    const type = f.size === 0 && !f.type ? 'directory' : 'file'
    const modifiedAt = new Date(f.lastModified).toISOString()
    return [{ path, name: baseName(path), type, size: f.size, modifiedAt }]
  })
  const paths = items.map((i) => i.path)
  if (!paths.length) return false
  if (dest.side === 'local') return copyLocal(items, dest)
  const { connected, server } = currentConnection()
  if (!connected || (dest.server ?? null) !== server) {
    toast.error(t(connected ? 'send.invalidOtherServer' : 'send.invalidNotConnected'))
    return false
  }
  return transfer('upload', paths, dest)
}

/**
 * OS에서 끌어 온 파일·폴더를 선반에 담는다. 폴더는 펼치지 않고 항목 하나다. 새로 담은 수를 돌려준다.
 * `getPathForFile`은 드롭 이벤트 안에서 await 앞에 모두 부른다(DataTransfer는 그때만 믿을 수 있다).
 */
export async function shelveOsFiles(files: readonly File[]): Promise<number> {
  if (!files.length) return 0
  const paths = files.map((f) => window.api.getPathForFile(f)).filter(Boolean)
  if (!paths.length) {
    toast(t('toast.shelfDropSkipped', { count: files.length }))
    return 0
  }
  let entries: LocalFileEntry[]
  try {
    const result = await window.api.invoke<IpcResult<LocalFileEntry[]>>('local:stat', paths)
    if (!result.success) {
      toast.error(t('toast.shelfDropSkipped', { count: files.length }), {
        description: result.error
      })
      return 0
    }
    entries = result.data
  } catch (err) {
    toast.error(t('toast.shelfDropSkipped', { count: files.length }), {
      description: err instanceof Error ? err.message : String(err)
    })
    return 0
  }
  const missing = files.length - entries.length
  if (missing > 0) toast(t('toast.shelfDropSkipped', { count: missing }))
  const added = useShelfStore.getState().add(entries.map(fromLocalEntry))
  if (entries.length && !added) toast(t('toast.alreadyOnShelf'))
  return added
}

let places: LocalPlaces | null = null
let placesRequest: Promise<LocalPlaces | null> | null = null

/** `local:getPlaces`를 한 번만 묻고 기억한다. 실패하면 null(다음에 다시 묻는다). */
export function loadPlaces(): Promise<LocalPlaces | null> {
  if (places) return Promise.resolve(places)
  placesRequest ??= window.api
    .invoke<IpcResult<LocalPlaces>>('local:getPlaces')
    .then((r) => {
      placesRequest = null
      if (r.success) places = r.data
      return places
    })
    .catch(() => {
      placesRequest = null
      return null
    })
  return placesRequest
}

/** "보내기 ▸"의 대상: 열린 탭, 최근 위치, 다운로드 폴더. 지금 위치는 빼고 최대 9개. */
export function sendDestinations(current: Loc): Loc[] {
  const { tabs, recent } = useTabsStore.getState()
  const out: Loc[] = []
  const add = (loc: Loc): void => {
    if (!sameLoc(loc, current) && !out.some((o) => sameLoc(o, loc))) out.push(loc)
  }
  tabs.forEach((tab) => add(tab.loc))
  recent.forEach(add)
  if (places?.downloads) add({ side: 'local', path: places.downloads })
  return out.slice(0, 9)
}

/**
 * 원격 탭의 서버(`"user@host:port"`)에 연결한다(D2·D6). 저장된 서버면 기존 연결 흐름:
 * 비밀번호가 저장돼 있으면 바로 연결하고, 아니면 툴바에 그 서버를 넣고 비밀번호 칸에 포커스를 준다.
 */
export function connectToServer(server: string): void {
  const at = server.lastIndexOf('@')
  const user = server.slice(0, Math.max(0, at))
  const hostPort = server.slice(at + 1)
  const colon = hostPort.lastIndexOf(':')
  const host = colon > 0 ? hostPort.slice(0, colon) : hostPort
  const port = colon > 0 ? Number(hostPort.slice(colon + 1)) : 21
  const store = useServerStore.getState()
  // 익명 연결은 저장된 사용자 이름이 비어 있어도 'anonymous'로 접속한다(useServerStore.connect).
  const saved = store.servers.find(
    (s) =>
      s.host === host && s.port === port && (s.username || 'anonymous') === (user || 'anonymous')
  )
  if (saved) return connectSaved(saved)
  store.setAddress(user ? `${user}@${hostPort}` : hostPort)
  focusPassword()
}

/** 저장된 서버에 연결한다(D6): 비밀번호가 저장돼 있으면 바로, 아니면 툴바에 넣고 비밀번호 칸에 포커스. */
export function connectSaved(saved: FtpServer): void {
  const store = useServerStore.getState()
  store.select(saved)
  if (saved.hasPassword) void store.connect()
  else focusPassword()
}

// 비밀번호 칸은 사용자 이름이 있을 때만 그려진다. 다음 프레임에 찾는다.
function focusPassword(): void {
  requestAnimationFrame(() =>
    document.querySelector<HTMLInputElement>('input[type="password"]')?.focus()
  )
}
