/**
 * 서버 드래그·선반 2단계의 연결 흐름(M15~M19): 분할을 먼저 만들고 20초를 재며 연결을 시도한다.
 * 성공은 `useFtpStore.connect`의 `adoptRemote`가 자리표시자 탭을 그 서버의 탭(최근 폴더 → 없으면
 * 루트)으로 제자리에서 채우고, 실패·타임아웃은 모달을 띄운 뒤 닫을 때 분할을 드롭 전 상태로
 * 되돌린다(M18). 연결 규칙은 1번 스펙의 `connectSaved`를 그대로 쓴다.
 */
import { t } from '@renderer/i18n'
import { connKey } from '@shared/connKey'
import { confirmDialog } from '@renderer/stores/useConfirmStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useTabsStore, visiblePanes, type PaneId } from '@renderer/stores/useTabsStore'
import { savedServerOf } from './connections'
import { sameLoc, type Loc } from './explorerEntry'
import { connectSaved, connectToServer } from './sendItems'
import { canConnectSaved, serverLabel } from './serverAddress'
import type { FtpServer } from '@shared/types/ftp'

/** M17: 분할 연결 시도의 타임아웃 — 이 시간이 지나면 시도를 취소하고 모달을 띄운다. */
export const SPLIT_CONNECT_TIMEOUT_MS = 20000

/**
 * P-C3: 분할 연결 대기(또는 진행) 중인 키의 표시. 자리표시자 탭이 마운트되는 순간 시도가 아직
 * 안 시작됐어도 게이트가 "연결 중"을 그리게 하고(M16 ①), 같은 키의 자동 연결(MC12)이 겹쳐
 * 이중 `ftp:connect`를 때리지 않게 한다(함정 I).
 */
const pendingConnects = new Set<string>()

/** 그 키가 분할 연결 흐름의 소관인가(렌더에서 쓴다 — 원격 탭의 게이트·자동 연결). */
export function isPendingConnect(server: string | undefined): boolean {
  return !!server && pendingConnects.has(server)
}

/**
 * M8: 연결 시도는 하나씩 — 지금 진행 중인 시도가 끝날 때까지 기다린다. upstream
 * `useServerStore.connect`는 `connecting`이면 즉시 거부하므로(P-C2), 둘째 시도를 받으려면
 * 기다려야 한다. 취소(`cancel`)로 `connecting`이 꺼지면 기다리던 시도가 바로 이어진다.
 */
async function whenAttemptsIdle(): Promise<void> {
  while (useServerStore.getState().connecting)
    await new Promise<void>((resolve) => {
      const unsub = useServerStore.subscribe((s) => {
        if (!s.connecting) {
          unsub()
          resolve()
        }
      })
    })
}

/** 분할 없이 잇는 시도(모달·복귀 없음). 앞 시도가 끝날 때까지 기다린다(M8). */
async function attemptPlain(server: FtpServer): Promise<void> {
  if (useServerStore.getState().connecting) await whenAttemptsIdle()
  await connectSaved(server).catch(() => false)
}

/**
 * M15: 분할 자리에 놓지 않은 서버 — 기존대로 그냥 연결만 한다(전환 + 탭, 모달·패널 없음).
 * 저장 비밀번호가 없으면 오늘처럼 주소 칸에 포커스만 준다.
 */
export function connectNow(server: FtpServer): void {
  const key = connKey(server.host, server.port, server.username)
  if (!canConnectSaved(server)) {
    connectToServer(key)
    return
  }
  void attemptPlain(server)
}

/** 시도 하나의 복귀 정보(M18·P-C4): 드롭 전 활성 탭과, 그 패널에서 치환됐던 탭. */
interface RevertState {
  /** 놓은 자리의 패널. null이면 분할을 건드리지 않는 시도(선반 2단계의 이미 분할된 상태). */
  pane: PaneId | null
  /** 새로 만든 자리표시자 탭. pane이 null이면 없다. */
  placeholder: string
  /** 치환돼 짝 밖으로 밀려난 탭(없으면 null — 드롭 전 분할이 없었다는 뜻, 함정 J). */
  displaced: string | null
  /** 드롭 전 활성 탭. */
  prevActiveId: string
}

/**
 * M16~M18의 한 흐름: 분할을 먼저 만들고(함정 F — 놓는 자리에서) 연결을 시도한다.
 * - ① 놓자마자 분할과 자리표시자 탭이 생기고 게이트가 연결 시도를 그린다(결과와 무관하다).
 * - ② 성공: `adoptRemote`가 그 자리표시자 탭을 제자리에서 채운다(최근 폴더 → 없으면 루트).
 * - ③ 실패·20초 타임아웃: 모달 → 닫으면 드롭 전 상태로 되돌린다(M18).
 * `pane`이 null이면 분할은 건드리지 않는다(M19′). 저장 로그인으로 바로 붙을 수 있는 서버만
 * 이 흐름을 연다 — 아니면 1번 스펙의 주소·비밀번호 경로로 간다(P-C6).
 */
export function connectIntoPane(server: FtpServer, pane: PaneId | null): void {
  const key = connKey(server.host, server.port, server.username)
  if (!canConnectSaved(server)) {
    connectToServer(key)
    return
  }
  const s = useTabsStore.getState()
  const prevActiveId = s.activeId
  // M18 ②용: 드롭 전에 분할이 보였다면 그 패널의 원래 탭을 치환 전에 기억한다.
  const shown = visiblePanes(s).length === 2
  const displaced =
    pane && shown && s.split ? (pane === 'left' ? s.split.leftId : s.split.rightId) : null
  // P-C3: 표시가 먼저 — 자리표시자 탭의 첫 렌더와 자동 연결이 이걸 읽는다.
  pendingConnects.add(key)
  let placeholder = ''
  if (pane) {
    // 비활성으로 열고 placeInPane이 짝을 만들게 한다(P-C1): 활성 탭이 곧 짝의 상대가 된다.
    placeholder = s.openTab({ side: 'remote', path: '/', server: key }, false)
    useTabsStore.getState().placeInPane(placeholder, pane)
  }
  void runConnect(key, server, { pane, placeholder, displaced, prevActiveId })
}

async function runConnect(key: string, server: FtpServer, rev: RevertState): Promise<void> {
  // M8: 앞 시도가 끝날 때까지 기다린다 — 시도가 시작돼야 20초가 흐른다(M17).
  if (useServerStore.getState().connecting) await whenAttemptsIdle()
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    // M17: 시도를 취소해야 뒤늦은 성공이 되돌아온 분할을 되살리지 못한다.
    useServerStore.getState().cancel()
    pendingConnects.delete(key)
    void showFailed(server, rev)
  }, SPLIT_CONNECT_TIMEOUT_MS)
  const ok = await connectSaved(server).catch(() => false)
  if (settled) return
  settled = true
  clearTimeout(timer)
  pendingConnects.delete(key)
  // M16 ③: 실패하면 모달 → 닫으면 복귀.
  if (!ok) void showFailed(server, rev)
}

/** 실패·타임아웃 공통: 모달을 닫으면 드롭 전 상태로 되돌린다(M16 ③·M18). */
async function showFailed(server: FtpServer, rev: RevertState): Promise<void> {
  await confirmDialog({
    title: t('split.connectFailedTitle', { name: serverLabel(server) }),
    message: t('split.connectFailedBody'),
    confirmLabel: t('common.close')
  })
  revert(rev)
}

/** M18: 새 분할이면 풀고(자리표시자 탭까지), 이미 있던 분할이면 치환됐던 탭을 그 패널로 되돌린다. */
function revert(rev: RevertState): void {
  const s = useTabsStore.getState()
  const inSplit =
    !!s.split && (s.split.leftId === rev.placeholder || s.split.rightId === rev.placeholder)
  if (rev.pane && rev.placeholder && inSplit && rev.displaced) {
    // ②: 치환됐던 탭을 그 패널로 되돌린다 — placeInPane이 짝을 다시 원래 탭으로 되돌린다.
    s.placeInPane(rev.displaced, rev.pane)
  }
  // ①: 짝의 반쪽이던 자리표시자를 닫으면 split이 풀리고 활성은 나머지 반쪽(= 드롭 전 탭)으로.
  if (rev.placeholder && s.tabs.some((t) => t.id === rev.placeholder))
    useTabsStore.getState().closeTab(rev.placeholder)
  const after = useTabsStore.getState()
  if (rev.prevActiveId !== after.activeId && after.tabs.some((t) => t.id === rev.prevActiveId))
    after.activate(rev.prevActiveId)
}

/**
 * M19: 선반 항목을 미연결 서버의 탭에 놓으면 — 전송하지 않고 ①연결(분할 + 자리표시자) →
 * ②성공 시 그 서버 패널이 열리고(선반 항목은 그대로) ③사용자가 다시 그 패널로 끬어 폴더를
 * 지정한다. 저장 로그인을 가진 서버일 때만 분할한다(P-C6) — 아니면 오늘의 주소·비밀번호 경로.
 * 분할이 이미 보이면 패널을 만들지 않는다(M19′): 짝 모델상 자리표시자 자리가 없고, 그 탭 자신의
 * 게이트가 연결 중을 그린다. 놓았던 탭을 활성으로 스쳐 그 탭 옆에 자리표시자가 생기게 한다(P-C5).
 */
export function startShelfConnect(dest: Loc): void {
  const key = dest.server
  if (!key) return
  const saved = savedServerOf(useServerStore.getState().servers, key)
  if (!saved) {
    connectToServer(key)
    return
  }
  const s = useTabsStore.getState()
  const shown = visiblePanes(s).length === 2
  const target = s.tabs.find((t) => sameLoc(t.loc, dest))
  if (target && target.id !== s.activeId) useTabsStore.getState().activate(target.id)
  connectIntoPane(saved, shown ? null : 'right')
}
