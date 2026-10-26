/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { en } from '@renderer/i18n/locales/en'
import { fromLocalEntry } from '@renderer/lib/explorerEntry'
import { emptyDraft } from '@renderer/lib/serverAddress'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useTabsStore, visiblePanes, type Tab } from '@renderer/stores/useTabsStore'
import { useDnd } from '@renderer/components/explorer/dnd'
import { AppShell } from '@renderer/components/layout/AppShell'
import { ConfirmDialog } from '@renderer/components/common/ConfirmDialog'
import { invokeCalls } from '@renderer/test/rendererTestUtils'
import {
  flush,
  ftp,
  local,
  localLoc,
  setConnection,
  setupExplorer,
  type ExplorerHarness
} from '@renderer/components/explorer/explorerTestHarness'
import type { FtpServer } from '@shared/types/ftp'

const HOME = 'C:\\Users\\me'
const OFFICE: FtpServer = {
  id: 2,
  name: 'Office',
  host: 'ftp.office.lan',
  port: 2121,
  username: 'kim',
  hasPassword: true,
  secure: false
}
const OFFICE_KEY = 'kim@ftp.office.lan:2121'
const NAS2: FtpServer = {
  id: 7,
  name: 'NAS2',
  host: 'b.lan',
  port: 21,
  username: 'bob',
  hasPassword: true,
  secure: false
}

const NAS3: FtpServer = {
  id: 8,
  name: 'NAS3',
  host: 'c.lan',
  port: 21,
  username: 'cat',
  hasPassword: true,
  secure: false
}

let h: ExplorerHarness
beforeEach(() => {
  vi.clearAllMocks()
  h = setupExplorer({
    local: { [HOME]: [local(HOME, 'a.txt')] },
    remote: { '/': [ftp('root.txt')], '/photos': [ftp('a.jpg')] }
  })
  h.handlers['ftp:getRecentServers'] = () => ({ success: true, data: [OFFICE, NAS2] })
  h.handlers['ftp:getRecentPaths'] = () => ({
    success: true,
    data: [{ path: '/photos', lastVisited: '' }]
  })
  useServerStore.setState({
    servers: [OFFICE, NAS2],
    draft: emptyDraft(),
    address: '',
    connecting: false,
    error: ''
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  h.restore()
})

const dt = (): Record<string, unknown> => ({
  types: [],
  files: [],
  dropEffect: '',
  setData: vi.fn(),
  setDragImage: vi.fn(),
  effectAllowed: ''
})

const state = (): ReturnType<typeof useTabsStore.getState> => useTabsStore.getState()

/** 로컬 탭 하나를 연 앱 전체(모달 포함)를 그린다. ConnectBar의 마운트 작업까지 비운다. */
async function renderApp(): Promise<void> {
  state().openTab(localLoc(HOME))
  render(
    <>
      <AppShell />
      <ConfirmDialog />
    </>
  )
  await flush()
}

/** 저장 서버를 콘텐츠 영역의 한쪽 절반에 놓는다(호버 → 놓기). */
function dropOn(side: 'left' | 'right', srv: FtpServer): void {
  act(() => useDnd.setState({ server: srv, items: null, over: null, thumbs: [], fromShelf: false }))
  const zone = screen.getAllByTestId(`split-${side}`)[0]
  fireEvent.dragOver(zone, { dataTransfer: dt() })
  fireEvent.drop(zone, { dataTransfer: dt() })
}

describe('SplitConnect — server drop opens a pane and connects', () => {
  it('creates the pane with a connecting placeholder right after the drop, before any result', async () => {
    // covers: Test-1259
    h.handlers['ftp:connect'] = () => new Promise(() => {}) // 연결 결과가 없다
    await renderApp()

    dropOn('right', OFFICE)

    // ① 놓자마자 — 결과와 무관하게 — 분할이 있고 그 칸에 연결 시도 안내가 뜬다.
    const s = state()
    expect(s.split).toBeTruthy()
    expect(visiblePanes(s)).toHaveLength(2)
    const pane = document.querySelector('[data-region="content"] [data-pane="right"]')
    expect(pane).toBeTruthy()
    expect(pane?.textContent).toContain(en['sidebar.serverConnecting'])
    expect(screen.queryByRole('alertdialog')).toBeNull()
    // 놓은 바로 그 순간 시도가 시작돼 있다(연결 시도 중 표시의 근거).
    expect(useServerStore.getState().connecting).toBe(true)
  })

  it('opens that server’s tab in the new pane on success: the last visited folder, else the root', async () => {
    // covers: Test-1260
    const connectByDrop = async (recent: string[]): Promise<Tab> => {
      cleanup()
      h.restore()
      h = setupExplorer({
        local: { [HOME]: [local(HOME, 'a.txt')] },
        remote: { '/': [ftp('root.txt')], '/photos': [ftp('a.jpg')] }
      })
      h.handlers['ftp:getRecentServers'] = () => ({ success: true, data: [OFFICE] })
      h.handlers['ftp:getRecentPaths'] = () => ({
        success: true,
        data: recent.map((path) => ({ path, lastVisited: '' }))
      })
      useServerStore.setState({
        servers: [OFFICE],
        draft: emptyDraft(),
        address: '',
        connecting: false,
        error: ''
      })
      await renderApp()
      dropOn('right', OFFICE)

      const expected = { side: 'remote', path: recent[0] ?? '/', server: OFFICE_KEY } as const
      await waitFor(() => {
        expect(useServerStore.getState().connecting).toBe(false)
        expect(useFtpStore.getState().connections[OFFICE_KEY]?.status).toBe('connected')
        const st = state()
        expect(st.tabs.find((t) => t.id === st.split?.rightId)?.loc).toEqual(expected)
      })
      const st = state()
      const tab = st.tabs.find((t) => t.id === st.split?.rightId)
      if (!tab) throw new Error('no tab in the new pane')
      // ② 자리표시자를 제자리에서 채웠다 — 탭이 하나 더 생긴 게 아니다(M13 상위 호환).
      expect(st.tabs).toHaveLength(2)
      return tab
    }

    // 최근 폴더가 있으면 그곳으로 연다.
    const first = await connectByDrop(['/photos'])
    expect(first.loc).toEqual({ side: 'remote', path: '/photos', server: OFFICE_KEY })
    expect(invokeCalls(h.invoke, 'ftp:list')).toContainEqual([OFFICE_KEY, '/photos'])

    // 없으면 루트로 연다.
    const second = await connectByDrop([])
    expect(second.loc).toEqual({ side: 'remote', path: '/', server: OFFICE_KEY })
  })

  it('shows the connect-failed modal on failure and reverts the new pane when it closes', async () => {
    // covers: Test-1261
    h.handlers['ftp:connect'] = () => ({ success: false, error: '530 Login incorrect' })
    await renderApp()
    const before = state().activeId

    dropOn('right', OFFICE)

    const modal = await screen.findByRole('alertdialog')
    expect(within(modal).getByText('Could not connect to Office')).toBeTruthy()
    expect(within(modal).getByText(en['split.connectFailedBody'])).toBeTruthy()
    // 모달을 닫기 전에는 분할이 그대로다.
    expect(state().split).toBeTruthy()
    expect(visiblePanes(state())).toHaveLength(2)

    fireEvent.click(within(modal).getByRole('button', { name: en['common.close'] }))
    // M18 ①: 드롭으로 만든 분할은 풀리고 자리표시자 탭까지 사라져 원래 활성 탭으로 돌아간다.
    await waitFor(() => expect(state().split).toBeNull())
    expect(document.querySelector('[data-region="content"] [data-pane="left"]')).toBeTruthy()
    expect(state().activeId).toBe(before)
    expect(state().tabs).toHaveLength(1)
  })

  it('times out after 20 s: cancels the attempt, shows the modal and reverts the pane', async () => {
    // covers: Test-1262
    h.handlers['ftp:connect'] = () => new Promise(() => {}) // 끝나지 않는 시도
    await renderApp()
    const before = state().activeId
    const realCancel = useServerStore.getState().cancel
    const cancel = vi.fn(() => realCancel())
    useServerStore.setState({ cancel })

    vi.useFakeTimers()
    dropOn('left', OFFICE)
    expect(state().split).toBeTruthy()

    act(() => vi.advanceTimersByTime(20000))

    // M17: 20초에 시도를 취소하고 모달을 띄운다.
    expect(cancel).toHaveBeenCalledTimes(1)
    const modal = screen.getByRole('alertdialog')
    expect(within(modal).getByText('Could not connect to Office')).toBeTruthy()
    vi.useRealTimers()

    fireEvent.click(within(modal).getByRole('button', { name: en['common.close'] }))
    await waitFor(() => expect(state().split).toBeNull())
    expect(state().activeId).toBe(before)
    expect(state().tabs).toHaveLength(1)
  })

  it('waits out a running attempt: the next server drop connects only after it settles', async () => {
    // covers: Test-1263
    const connects: Array<(result: unknown) => void> = []
    h.handlers['ftp:connect'] = () => new Promise((resolve) => connects.push(resolve))
    await renderApp()

    dropOn('right', OFFICE)
    await waitFor(() => expect(invokeCalls(h.invoke, 'ftp:connect')).toHaveLength(1))
    expect(state().split).toBeTruthy()

    // 첫 시도가 끝나기 전에 다른 서버를 놓아도 시도는 하나씩이다(M8).
    dropOn('left', NAS2)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(invokeCalls(h.invoke, 'ftp:connect')).toHaveLength(1)
    expect(visiblePanes(state())).toHaveLength(2) // 두 패널이면 셋째는 없다

    // 첫 시도가 끝나면 둘째가 잇는다.
    act(() => {
      connects[0]({ success: true, data: undefined })
    })
    await waitFor(() => expect(invokeCalls(h.invoke, 'ftp:connect')).toHaveLength(2))
    expect(invokeCalls(h.invoke, 'ftp:connect')[1][0]).toMatchObject({ host: NAS2.host })
    act(() => {
      connects[1]({ success: false, error: 'nope' })
    })
    await waitFor(() => expect(useServerStore.getState().connecting).toBe(false))
  })

  it('runs queued attempts one by one: B and C each really try after the one before settles', async () => {
    // covers: Test-1280
    const connects: Array<(result: unknown) => void> = []
    h.handlers['ftp:connect'] = () => new Promise((resolve) => connects.push(resolve))
    await renderApp()
    const tick = async (): Promise<void> => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }

    dropOn('right', OFFICE)
    await waitFor(() => expect(invokeCalls(h.invoke, 'ftp:connect')).toHaveLength(1))
    // 앞 시도가 진행 중일 때 B와 C를 차례로 놓는다.
    dropOn('left', NAS2)
    dropOn('right', NAS3)
    await tick()
    expect(invokeCalls(h.invoke, 'ftp:connect')).toHaveLength(1)

    act(() => connects[0]({ success: true, data: undefined }))
    await waitFor(() => expect(invokeCalls(h.invoke, 'ftp:connect')).toHaveLength(2))
    expect(invokeCalls(h.invoke, 'ftp:connect')[1][0]).toMatchObject({ host: NAS2.host })
    await tick()
    // C는 시도 없이 실패하지 않는다: B가 끝날 때까지 기다린다.
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(invokeCalls(h.invoke, 'ftp:connect')).toHaveLength(2)

    act(() => connects[1]({ success: true, data: undefined }))
    await waitFor(() => expect(invokeCalls(h.invoke, 'ftp:connect')).toHaveLength(3))
    expect(invokeCalls(h.invoke, 'ftp:connect')[2][0]).toMatchObject({ host: NAS3.host })
    act(() => connects[2]({ success: true, data: undefined }))
    await waitFor(() => expect(useServerStore.getState().connecting).toBe(false))
    await tick()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('keeps a success whose finishing overlaps the 20 s timer and cancels no other attempt', async () => {
    // covers: Test-1281
    const connects: Array<(result: unknown) => void> = []
    h.handlers['ftp:connect'] = () => new Promise((resolve) => connects.push(resolve))
    await renderApp()
    // 성공 처리(저장 서버 목록 다시 읽기)를 붙잡아 둔다 — 그 사이에 20초가 지난다.
    let releaseServers = (): void => undefined
    h.handlers['ftp:getRecentServers'] = () =>
      new Promise((resolve) => {
        releaseServers = () => resolve({ success: true, data: [OFFICE, NAS2] })
      })
    const settle = async (ms = 0): Promise<void> => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
        for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0)
      })
    }

    vi.useFakeTimers()
    dropOn('right', OFFICE)
    await settle()
    expect(invokeCalls(h.invoke, 'ftp:connect')).toHaveLength(1)
    await settle(19000)
    dropOn('left', NAS2) // 줄 선 다음 시도

    // 19초에 로그인이 성공한다. 성공 처리가 끝나기 전에 첫 시도의 20초 타이머가 울린다.
    connects[0]({ success: true, data: undefined })
    await settle()
    await settle(1500)
    releaseServers()
    await settle()

    // 성공한 패널은 그대로이고 실패 모달·복귀가 없다. 다른 시도도 끊지 않았다.
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(invokeCalls(h.invoke, 'ftp:disconnect')).toEqual([])
    const st = state()
    expect(st.split).toBeTruthy()
    expect(st.tabs.find((t) => t.id === st.split?.rightId)?.loc).toMatchObject({
      side: 'remote',
      server: OFFICE_KEY
    })
  })

  it('puts an already connected server’s tab into the pane without connecting', async () => {
    // covers: Test-1282
    setConnection(OFFICE_KEY, 'connected')
    await renderApp()
    const cancel = vi.fn()
    useServerStore.setState({ cancel })

    vi.useFakeTimers()
    dropOn('right', OFFICE)
    const st = state()
    expect(st.split).toBeTruthy()
    expect(st.tabs.find((t) => t.id === st.split?.rightId)?.loc).toMatchObject({
      side: 'remote',
      server: OFFICE_KEY
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000)
    })
    expect(invokeCalls(h.invoke, 'ftp:connect')).toEqual([])
    expect(invokeCalls(h.invoke, 'ftp:disconnect')).toEqual([])
    expect(cancel).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(state().split).toBeTruthy()
  })

  it('reactivates the tab active before a shelf drop when its connect fails', async () => {
    // covers: Test-1283
    const ANON: FtpServer = {
      id: 9,
      name: 'Pub',
      host: 'p.lan',
      port: 21,
      username: '',
      hasPassword: false,
      secure: false
    }
    const ANON_KEY = 'anonymous@p.lan:21'
    h.handlers['ftp:getRecentServers'] = () => ({ success: true, data: [ANON] })
    h.handlers['ftp:connect'] = () => ({ success: false, error: '530 Login incorrect' })
    useServerStore.setState({ servers: [ANON] })
    await renderApp()
    state().openTab({ side: 'remote', path: '/old', server: ANON_KEY }, false)
    await flush()
    const before = state().activeId

    // 선반 항목을 미연결 서버의 탭에 놓는다(2단계 흐름).
    act(() =>
      useDnd.setState({
        items: [fromLocalEntry(local(HOME, 'a.txt'))],
        fromShelf: true,
        server: null,
        over: null,
        thumbs: []
      })
    )
    const tab = screen.getByRole('tab', { name: 'old' })
    fireEvent.dragOver(tab, { dataTransfer: dt() })
    fireEvent.drop(tab, { dataTransfer: dt() })

    const modal = await screen.findByRole('alertdialog')
    fireEvent.click(within(modal).getByRole('button', { name: en['common.close'] }))
    await waitFor(() => expect(state().split).toBeNull())
    expect(state().activeId).toBe(before)
  })
})
