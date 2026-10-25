/**
 * 서버 드래그·선반 2단계의 연결 흐름(M16~M19): 패널을 먼저 만들고 20초를 재며 연결을 시도한다.
 * 성공은 `useFtpStore.connect`의 `adoptRemote`가 포커스 패널의 자리표시자 탭을 그 서버의
 * 탭(최근 폴더 → 없으면 루트)으로 채우고, 실패·타임아웃은 모달을 띄운 뒤 닫을 때 패널을
 * 드롭 전 상태로 되돌린다. 연결 규칙은 1번 스펙의 `connectSaved`를 그대로 쓴다.
 */
import { t } from '@renderer/i18n'
import { confirmDialog } from '@renderer/stores/useConfirmStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { focusedPane, useTabsStore } from '@renderer/stores/useTabsStore'
import { connectSaved, connectToServer } from './sendItems'
import { canConnectSaved, serverKey, serverLabel } from './serverAddress'
import type { Loc } from './explorerEntry'
import type { FtpServer } from '@shared/types/ftp'

/** M17: 분할 연결 시도의 타임아웃 — 이 시간이 지나면 시도를 취소하고 모달을 띄운다. */
export const SPLIT_CONNECT_TIMEOUT_MS = 20000

/**
 * M8: 연결 시도는 하나씩 — 지금 진행 중인 시도가 끝날 때까지 기다린다. 취소(`cancel`)로
 * `connecting`이 꺼지면 기다리던 시도가 바로 이어진다.
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

/** 분할 없이 잇는 시도(모달·복귀 없음). */
async function attemptPlain(server: FtpServer): Promise<void> {
  if (useServerStore.getState().connecting) await whenAttemptsIdle()
  await connectSaved(server).catch(() => false)
}

/**
 * M15: 분할 자리가 아니에 놓은 서버 — 기존대로 그냥 연결만 한다(전환 + 탭, 모달 없음).
 * 저장 비밀번호가 없으면 오늘처럼 주소 칸에 포커스만 준다.
 */
export function connectNow(server: FtpServer): void {
  if (!canConnectSaved(server)) {
    connectToServer(serverKey(server))
    return
  }
  void attemptPlain(server)
}

/**
 * M16~M18의 한 흐름: 패널을 먼저 만들고(함정 F — 놓는 자리에서) 연결을 시도한다.
 * - ① 놓자마자 패널과 "연결 시도 중" 자리표시자가 생긴다(결과와 무관하다).
 * - ② 성공: `adoptRemote`가 그 패널의 자리표시자 탭을 제자리에서 채운다.
 * - ③ 실패·20초 타임아웃: 모달 → 닫으면 드롭 전 상태로 되돌린다(M18).
 * `makePane`은 즉시 시도할 수 있는 서버일 때만 불린다 — 연결할 수 없는 서버는 분할하지 않는다.
 */
export function connectIntoPane(server: FtpServer, makePane: () => string): void {
  if (!canConnectSaved(server)) {
    connectToServer(serverKey(server))
    return
  }
  const prevActiveId = useTabsStore.getState().activeId
  const paneId = makePane()
  void runConnect(paneId, server, prevActiveId)
}

async function runConnect(paneId: string, server: FtpServer, prevActiveId: string): Promise<void> {
  // M8: 앞 시도가 끝날 때까지 기다린다 — 시도가 시작돼야 20초가 흐른다(M17).
  if (useServerStore.getState().connecting) await whenAttemptsIdle()
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    // M17: 시도를 취소해야 뒤늦은 성공이 되돌아온 패널을 되살리지 못한다.
    useServerStore.getState().cancel()
    void showFailed(server, paneId, prevActiveId)
  }, SPLIT_CONNECT_TIMEOUT_MS)
  const ok = await connectSaved(server).catch(() => false)
  if (settled) return
  settled = true
  clearTimeout(timer)
  // M16 ③: 실패하면 모달 → 닫으면 복귀.
  if (!ok) void showFailed(server, paneId, prevActiveId)
}

/** 실패·타임아웃 공통: 모달을 닫으면 드롭 전 상태로 되돌린다(M16 ③·M18). */
async function showFailed(server: FtpServer, paneId: string, prevActiveId: string): Promise<void> {
  await confirmDialog({
    title: t('split.connectFailedTitle', { name: serverLabel(server) }),
    message: t('split.connectFailedBody'),
    confirmLabel: t('common.close')
  })
  revertPane(paneId, prevActiveId)
}

/** M18: 새로 만든 패널이면 패널 자체를(자리표시자 탭까지) 제거하고, 아니면 활성 탭만 원래로. */
function revertPane(paneId: string, prevActiveId: string): void {
  const s = useTabsStore.getState()
  const pane = paneId ? s.panes.find((p) => p.id === paneId) : undefined
  if (pane) {
    const placeholder = pane.activeTabId
    s.closePane(pane.id)
    s.closeTab(placeholder)
  } else if (prevActiveId && s.tabs.some((t) => t.id === prevActiveId)) {
    s.activate(prevActiveId)
  }
}

/**
 * M19: 선반 항목을 미연결 서버의 탭에 놓으면 — 전송하지 않고 ①연결(분할 + 자리표시자) →
 * ②성공 시 그 서버 패널이 열리고(선반 항목은 그대로) ③사용자가 다시 그 패널로 끌어 폴더를
 * 지정한다. 저장 로그인을 가진 서버일 때만 분할한다 — 아니면 오늘의 주소·비밀번호 경로로 보낸다.
 */
export function startShelfConnect(dest: Loc): void {
  const key = dest.server
  if (!key) return
  const saved = useServerStore.getState().servers.find((s) => serverKey(s) === key)
  if (!saved) {
    connectToServer(key)
    return
  }
  connectIntoPane(saved, () => {
    const s = useTabsStore.getState()
    return s.split(focusedPane(s)?.id ?? '', { pending: dest })
  })
}
