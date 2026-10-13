/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { en } from '@renderer/i18n/locales/en'
import { generateCacheKeyRenderer } from '@renderer/lib/cacheKey'
import { fromFtpEntry, type Loc } from '@renderer/lib/explorerEntry'
import { optId } from '@renderer/lib/explorerLayout'
import { useGalleryStore } from '@renderer/stores/useGalleryStore'
import { useThumbnailStore } from '@renderer/stores/useThumbnailStore'
import { useTabsStore, type PaneId, type Tab } from '@renderer/stores/useTabsStore'
import { invokeCalls, stubMenuViewport } from '@renderer/test/rendererTestUtils'
import { useDnd } from './dnd'
import {
  flush,
  ftp,
  local,
  localLoc,
  MODIFIED_AT,
  paneEl,
  remoteLoc,
  server,
  setupExplorer,
  stubRect,
  type ExplorerHarness
} from './explorerTestHarness'
import { Explorer } from './Explorer'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() })
}))

const DIR = '/photos'
const LDIR = 'C:\\work'
let h: ExplorerHarness

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  h.restore()
})

const tabOf = (id: string): Tab => {
  const tab = useTabsStore.getState().tabs.find((x) => x.id === id)
  if (!tab) throw new Error(`no tab ${id}`)
  return tab
}

/** 탭 두 개를 열어 짝 {왼쪽, 오른쪽}을 만들고 탐색기를 그린다. */
async function renderSplit(
  left: Loc,
  right: Loc,
  opts: {
    ratio?: number
    active?: PaneId
    leftPatch?: Partial<Tab>
    rightPatch?: Partial<Tab>
  } = {}
): Promise<{ L: string; R: string }> {
  const s = useTabsStore.getState()
  const L = s.openTab(left)
  s.patchTab(L, opts.leftPatch ?? {})
  const R = s.openTab(right)
  s.patchTab(R, opts.rightPatch ?? {})
  useTabsStore.setState({
    split: { leftId: L, rightId: R, ratio: opts.ratio ?? 0.5 },
    activeId: opts.active === 'right' ? R : L
  })
  render(<Explorer />)
  await flush()
  return { L, R }
}

const listOf = (id: string): HTMLElement => {
  const el = document.getElementById(`explorer-list-${id}`)
  if (!el) throw new Error(`no list for ${id}`)
  return el
}

const baseName = (p: string): string =>
  p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1)

/** 그 패널 안에서 이름으로 찾은 항목 */
function paneOption(pane: PaneId, name: string): HTMLElement {
  const el = within(paneEl(pane))
    .queryAllByRole('option')
    .find((o) => baseName(o.getAttribute('data-path') ?? '') === name)
  if (!el) throw new Error(`no option "${name}" in ${pane}`)
  return el
}

const dt = (): Record<string, unknown> => ({
  setData: vi.fn(),
  setDragImage: vi.fn(),
  effectAllowed: '',
  dropEffect: '',
  types: [],
  files: []
})

const rootCrumb = (pane: PaneId, loc: Loc): HTMLElement =>
  within(paneEl(pane)).getByRole('button', {
    name: en['place.root'].replace(
      '{{source}}',
      loc.side === 'local' ? en['sidebar.thisPc'] : 'example.org:21'
    )
  })

describe('SplitView — panes', () => {
  it('draws a visible pair as two panes with their own path bars, items, ratio and a divider; a tab outside the pair is one pane', async () => {
    // covers: Test-1058
    h = setupExplorer({
      local: { [LDIR]: [local(LDIR, 'l.txt')] },
      remote: { [DIR]: [ftp('r.jpg')] }
    })
    const { L, R } = await renderSplit(localLoc(LDIR), remoteLoc(DIR), { ratio: 0.3 })
    const X = useTabsStore.getState().openTab(localLoc(LDIR), false)

    expect(document.querySelectorAll('section[data-pane]')).toHaveLength(2)
    expect(paneEl('left').getAttribute('data-tab-pane')).toBe(L)
    expect(paneEl('right').getAttribute('data-tab-pane')).toBe(R)
    expect(screen.getAllByRole('button', { name: en['explorer.back'] })).toHaveLength(2)
    expect(
      within(paneEl('left')).getAllByRole('button', { name: en['explorer.back'] })
    ).toHaveLength(1)
    expect(paneOption('left', 'l.txt')).toBeTruthy()
    expect(paneOption('right', 'r.jpg')).toBeTruthy()
    expect(() => paneOption('left', 'r.jpg')).toThrow()
    expect(paneEl('left').style.flexBasis).toBe('30%')
    expect(paneEl('right').style.flexBasis).toBe('70%')
    const divider = screen.getByRole('separator')
    expect([paneEl('left').style.order, divider.style.order, paneEl('right').style.order]).toEqual([
      '0',
      '1',
      '2'
    ])

    act(() => useTabsStore.getState().activate(X))
    await flush()
    expect(document.querySelectorAll('section[data-pane]')).toHaveLength(1)
    expect(paneEl('left').getAttribute('data-tab-pane')).toBe(X)
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('marks only the active pane, dims the other path bar, and activates a pane on pointerdown or focus', async () => {
    // covers: Test-1059
    h = setupExplorer({
      local: { [LDIR]: [local(LDIR, 'l.txt')] },
      remote: { [DIR]: [ftp('r.jpg')] }
    })
    const { L, R } = await renderSplit(localLoc(LDIR), remoteLoc(DIR))
    const active = (): string => useTabsStore.getState().activeId

    expect(paneEl('left').hasAttribute('data-active')).toBe(true)
    expect(paneEl('right').hasAttribute('data-active')).toBe(false)
    expect(within(paneEl('left')).getByTestId('pane-active-bar')).toBeTruthy()
    expect(within(paneEl('right')).queryByTestId('pane-active-bar')).toBeNull()
    expect(paneEl('right').querySelector('[data-dim]')).not.toBeNull()
    expect(paneEl('left').querySelector('[data-dim]')).toBeNull()

    fireEvent.pointerDown(paneOption('right', 'r.jpg'))
    expect(active()).toBe(R)
    expect(paneEl('right').hasAttribute('data-active')).toBe(true)
    expect(paneEl('left').querySelector('[data-dim]')).not.toBeNull()

    act(() => listOf(R).focus())
    expect(active()).toBe(R)
    act(() => listOf(L).focus())
    expect(active()).toBe(L)

    // 단일 보기에는 상단 바가 없다.
    const X = useTabsStore.getState().openTab(localLoc(LDIR))
    await flush()
    expect(document.querySelectorAll('section[data-pane]')).toHaveLength(1)
    expect(screen.queryByTestId('pane-active-bar')).toBeNull()

    // 숨은 짝의 두 패널이 함께 마운트되면 body 포커스는 활성 패널의 목록이 받는다.
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)
    act(() => useTabsStore.getState().activate(R))
    await flush()
    expect(document.querySelectorAll('section[data-pane]')).toHaveLength(2)
    expect(document.activeElement).toBe(listOf(R))
    expect(active()).toBe(R)
    expect(X).not.toBe(R)
  })

  it('moves the pane’s own tab from its back button and from springs while the other pane is active', async () => {
    // covers: Test-1060
    h = setupExplorer({
      remote: {
        '/': [ftp('photos', { dir: true })],
        [DIR]: [ftp('sub', { dir: true }), ftp('a.jpg')],
        [`${DIR}/sub`]: []
      }
    })
    const { L, R } = await renderSplit(remoteLoc('/'), remoteLoc('/'))
    act(() => {
      useTabsStore.getState().navigate(remoteLoc(DIR), { tabId: L })
      useTabsStore.getState().navigate(remoteLoc(DIR), { tabId: R })
    })
    await flush()
    expect(useTabsStore.getState().activeId).toBe(L)

    fireEvent.click(within(paneEl('right')).getByRole('button', { name: en['explorer.back'] }))
    await flush()
    expect(tabOf(R).loc.path).toBe('/')
    expect(tabOf(L).loc.path).toBe(DIR)

    // 파일 드래그 중 오른쪽(비활성) 패널의 폴더 타일 스프링은 오른쪽 탭을 옮긴다.
    vi.useFakeTimers()
    act(() =>
      useDnd.setState({
        items: [fromFtpEntry(ftp('x.jpg'), '/elsewhere', server())],
        over: null,
        thumbs: []
      })
    )
    fireEvent.dragOver(paneOption('right', 'photos'), { dataTransfer: dt() })
    await act(() => vi.advanceTimersByTimeAsync(599))
    expect(tabOf(R).loc.path).toBe('/')
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(tabOf(R).loc.path).toBe(DIR)
    expect(tabOf(L).loc.path).toBe(DIR)
    expect(useTabsStore.getState().activeId).toBe(L)

    // 경로 조각도 같다. 두 패널에 같은 조각이 있어도 오른쪽 것만 강조된다.
    act(() => useDnd.setState({ over: null }))
    fireEvent.dragOver(rootCrumb('right', remoteLoc('/')), { dataTransfer: dt() })
    expect(within(rootCrumb('right', remoteLoc('/'))).queryByText('Move 1')).not.toBeNull()
    expect(within(rootCrumb('left', remoteLoc('/'))).queryByText('Move 1')).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(600))
    expect(tabOf(R).loc.path).toBe('/')
    expect(tabOf(L).loc.path).toBe(DIR)
  })

  it('keeps ids, the active descendant and drop highlights apart when both panes show the same folder', async () => {
    // covers: Test-1061
    h = setupExplorer({
      remote: { [DIR]: [ftp('sub', { dir: true }), ftp('a.jpg')], [`${DIR}/sub`]: [] }
    })
    const a = `${DIR}/a.jpg`
    const sel = { sel: [a], anchor: a, focus: a }
    const { L, R } = await renderSplit(remoteLoc(DIR), remoteLoc(DIR), {
      leftPatch: sel,
      rightPatch: sel
    })

    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const [pane, id] of [
      ['left', L],
      ['right', R]
    ] as const) {
      const list = within(paneEl(pane)).getByRole('listbox')
      expect(list.getAttribute('aria-activedescendant')).toBe(optId(a, id))
      expect(list.querySelector(`#${CSS.escape(optId(a, id))}`)).not.toBeNull()
    }

    act(() =>
      useDnd.setState({
        items: [fromFtpEntry(ftp('x.jpg'), '/elsewhere', server())],
        over: null,
        thumbs: []
      })
    )
    fireEvent.dragOver(paneOption('right', 'sub'), { dataTransfer: dt() })
    expect(within(paneOption('right', 'sub')).queryByText('Move 1')).not.toBeNull()
    expect(within(paneOption('left', 'sub')).queryByText('Move 1')).toBeNull()

    act(() => useDnd.setState({ items: null, over: null, thumbs: [] }))
    const X = useTabsStore.getState().openTab(remoteLoc(DIR))
    act(() => useTabsStore.getState().patchTab(X, sel))
    await flush()
    expect(document.querySelectorAll('section[data-pane]')).toHaveLength(1)
    expect(screen.getByRole('listbox').getAttribute('aria-activedescendant')).toBe(optId(a))
  })

  it('looks up the menu anchor and the drag thumbnails inside the pane', async () => {
    // covers: Test-1062
    h = setupExplorer({ remote: { [DIR]: [ftp('a.jpg'), ftp('b.jpg')] } })
    const a = `${DIR}/a.jpg`
    const thumbKey = generateCacheKeyRenderer(server(), a, 1024, MODIFIED_AT)
    useThumbnailStore.setState({
      thumbnails: { [thumbKey]: { dataUrl: 'data:image/jpeg;base64,UkVE', width: 1, height: 1 } }
    })
    const { R } = await renderSplit(remoteLoc(DIR), remoteLoc(DIR), {
      active: 'right',
      rightPatch: { sel: [a], anchor: a, focus: a }
    })
    stubRect(paneOption('left', 'a.jpg'), { left: 100, top: 200, width: 160, height: 100 })
    stubRect(paneOption('right', 'a.jpg'), { left: 700, top: 250, width: 160, height: 100 })
    const viewport = stubMenuViewport({ width: 200, height: 300 }, { width: 2000, height: 1500 })
    try {
      fireEvent.keyDown(listOf(R), { key: 'F10', shiftKey: true })
      const menu = screen.getByRole('menu')
      expect(menu.style.left).toBe('724px')
      expect(menu.style.top).toBe('290px')
    } finally {
      viewport.restore()
    }
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    const leftImg = paneOption('left', 'a.jpg').querySelector('img')
    const rightImg = paneOption('right', 'a.jpg').querySelector('img')
    expect(rightImg).not.toBeNull()
    leftImg?.setAttribute('src', 'data:image/jpeg;base64,TEVGVA==')
    fireEvent.dragStart(paneOption('right', 'a.jpg'), { dataTransfer: dt() })
    expect(useDnd.getState().thumbs).toEqual([rightImg?.getAttribute('src')])
  })

  it('sends between panes with the existing plan: upload to the other side, move on the same server, refuse its own folder', async () => {
    // covers: Test-1063
    h = setupExplorer({
      local: { [LDIR]: [local(LDIR, 'l.jpg')] },
      remote: { [DIR]: [ftp('f.jpg')], '/b': [ftp('other.txt')] }
    })
    h.handlers['transfer:send'] = () => ({
      success: true,
      data: { batchId: 'b1', ids: ['1'], skipped: [], conflicts: [], totalBytes: 1 }
    })
    const { R } = await renderSplit(localLoc(LDIR), remoteLoc(DIR))

    fireEvent.dragStart(paneOption('left', 'l.jpg'), { dataTransfer: dt() })
    fireEvent.dragOver(listOf(R), { dataTransfer: dt() })
    expect(within(paneEl('right')).getByText('Upload 1 to photos')).toBeTruthy()
    fireEvent.drop(listOf(R), { dataTransfer: dt() })
    await flush()
    const [conn, req] = invokeCalls(h.invoke, 'transfer:send')[0]
    expect(conn).toBe(server())
    expect(req).toMatchObject({ direction: 'upload', sources: [`${LDIR}\\l.jpg`], destDir: DIR })

    // 같은 서버의 두 원격 패널 사이는 이동, 자기 패널 빈 곳은 무효
    const M = useTabsStore.getState().openTab(remoteLoc('/b'), false)
    act(() => useTabsStore.setState({ split: { leftId: R, rightId: M, ratio: 0.5 }, activeId: R }))
    await flush()
    fireEvent.dragStart(paneOption('left', 'f.jpg'), { dataTransfer: dt() })
    fireEvent.dragOver(listOf(R), { dataTransfer: dt() })
    expect(within(paneEl('left')).getByText(en['send.invalidHere'])).toBeTruthy()
    fireEvent.dragOver(listOf(M), { dataTransfer: dt() })
    fireEvent.drop(listOf(M), { dataTransfer: dt() })
    await flush()
    expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([[server(), `${DIR}/f.jpg`, '/b/f.jpg']])
  })

  it('scopes thumbnail batches, folder previews and cancels to the pane id', async () => {
    // covers: Test-1064
    h = setupExplorer({
      remote: {
        [DIR]: [ftp('sub', { dir: true }), ftp('a.jpg'), ftp('b.jpg')],
        [`${DIR}/2024`]: []
      }
    })
    // 보이는 즉시 콜백한다. 실제 IntersectionObserver처럼 observe 뒤 비동기(마이크로태스크)로 부른다.
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private live = true
        constructor(private cb: IntersectionObserverCallback) {}
        observe = (el: Element): void =>
          queueMicrotask(() => {
            if (this.live)
              this.cb(
                [{ isIntersecting: true, target: el } as unknown as IntersectionObserverEntry],
                this as unknown as IntersectionObserver
              )
          })
        disconnect = (): void => {
          this.live = false
        }
      }
    )
    h.handlers['gallery:remoteFolderPreview'] = () => ({
      success: true,
      data: { name: 'x.jpg', size: 10, modifiedAt: MODIFIED_AT, itemCount: 1 }
    })
    const S = server()
    const innerKey = generateCacheKeyRenderer(S, `${DIR}/sub/x.jpg`, 10, MODIFIED_AT)
    useThumbnailStore.setState({
      thumbnails: { [innerKey]: { dataUrl: 'data:image/jpeg;base64,AA==', width: 1, height: 1 } }
    })
    const reqs = [`${DIR}/a.jpg`, `${DIR}/b.jpg`]
    const batchPaths = (viewer: string): string[][] =>
      invokeCalls(h.invoke, 'thumbnail:requestBatch')
        .filter(([conn, v]) => conn === S && v === viewer)
        .map(([, , r]) => (r as Array<{ remotePath: string }>).map((x) => x.remotePath).sort())
    const previews = (): unknown[][] => invokeCalls(h.invoke, 'gallery:remoteFolderPreview')
    const cancels = (channel: string, viewer: string): number =>
      invokeCalls(h.invoke, channel).filter(([conn, v]) => conn === null && v === viewer).length
    const subEntry = (): string | undefined =>
      useGalleryStore.getState().remoteFolderPreviews[`${S}|${DIR}/sub`]?.status

    // ① 마운트: 패널마다 자기 뷰어로
    const { L, R } = await renderSplit(remoteLoc(DIR), remoteLoc(DIR))
    await flush()
    expect(batchPaths('left')).toContainEqual(reqs)
    expect(batchPaths('right')).toContainEqual(reqs)
    expect(previews()).toContainEqual([S, { remotePath: `${DIR}/sub`, viewerId: 'left' }])
    expect(previews()).toContainEqual([S, { remotePath: `${DIR}/sub`, viewerId: 'right' }])
    expect(subEntry()).toBe('resolved')

    // ② 왼쪽 이동은 왼쪽 뷰어만 취소하고, 지워진 오른쪽 폴더 미리보기는 다시 요청한다(P17).
    h.invoke.mockClear()
    act(() => useTabsStore.getState().navigate(remoteLoc(`${DIR}/2024`), { tabId: L }))
    await flush()
    await flush()
    for (const channel of ['thumbnail:cancelAll', 'gallery:cancelAll']) {
      expect(cancels(channel, 'left')).toBe(1)
      expect(cancels(channel, 'right')).toBe(0)
    }
    expect(previews()).toContainEqual([S, { remotePath: `${DIR}/sub`, viewerId: 'right' }])
    expect(subEntry()).toBe('resolved')
    expect(
      within(paneOption('right', 'sub')).getByAltText(
        en['preview.folderAlt'].replace('{{path}}', `${DIR}/sub`)
      )
    ).toBeTruthy()

    // ③ 활성 L인 채 해제: 사라지는 오른쪽 패널의 뷰어만 취소한다.
    act(() => useTabsStore.getState().navigate(remoteLoc(DIR), { tabId: L }))
    await flush()
    h.invoke.mockClear()
    act(() => useTabsStore.getState().unsplit())
    await flush()
    for (const channel of ['thumbnail:cancelAll', 'gallery:cancelAll']) {
      expect(cancels(channel, 'right')).toBe(1)
      expect(cancels(channel, 'left')).toBe(0)
    }

    // ④ 오른쪽 활성인 채 해제: L이 사라지고 R이 단일 'left'가 된다. 옛 뷰어 취소 → 새 뷰어 배치.
    act(() => useTabsStore.setState({ split: { leftId: L, rightId: R, ratio: 0.5 } }))
    await flush()
    act(() => useTabsStore.getState().activate(R))
    await flush()
    h.invoke.mockClear()
    act(() => useTabsStore.getState().unsplit())
    await flush()
    const order = h.invoke.mock.invocationCallOrder
    const calls = h.invoke.mock.calls
    const cancelOrders = calls.flatMap((c, i) => (/:cancelAll$/.test(c[0]) ? [order[i]] : []))
    for (const channel of ['thumbnail:cancelAll', 'gallery:cancelAll']) {
      expect(cancels(channel, 'right')).toBe(1)
      expect(cancels(channel, 'left')).toBeGreaterThanOrEqual(1)
    }
    const batch = calls.findIndex(
      (c) =>
        c[0] === 'thumbnail:requestBatch' &&
        c[1] === S &&
        c[2] === 'left' &&
        (c[3] as Array<{ remotePath: string }>)
          .map((x) => x.remotePath)
          .sort()
          .join() === reqs.join()
    )
    expect(batch).toBeGreaterThanOrEqual(0)
    expect(order[batch]).toBeGreaterThan(Math.max(...cancelOrders))
  })

  it('keeps an open rename and the scroll position when the panes swap or the split starts', async () => {
    // covers: Test-1065
    h = setupExplorer({
      remote: { [DIR]: [ftp('a.txt'), ftp('b.txt')] },
      local: { [LDIR]: [local(LDIR, 'l.txt')] }
    })
    const { L, R } = await renderSplit(remoteLoc(DIR), localLoc(LDIR))
    act(() => listOf(L).focus())
    fireEvent.keyDown(listOf(L), { key: 'Home' })
    fireEvent.keyDown(listOf(L), { key: 'F2' })
    const input = within(paneEl('left')).getByRole('textbox', { name: en['menu.newName'] })
    fireEvent.change(input, { target: { value: 'typed.txt' } })
    const rightList = listOf(R)
    rightList.scrollTop = 120

    act(() => useTabsStore.getState().swapPanes())
    await flush()
    expect(input.isConnected).toBe(true)
    expect((input as HTMLInputElement).value).toBe('typed.txt')
    expect(paneEl('right').contains(input)).toBe(true)
    expect(listOf(R)).toBe(rightList)
    expect(rightList.scrollTop).toBe(120)

    // 단일 보기에서 입력을 연 채 분할을 만들어도 그대로
    act(() => useTabsStore.getState().unsplit())
    await flush()
    expect(document.querySelectorAll('section[data-pane]')).toHaveLength(1)
    act(() => useTabsStore.getState().placeInPane(R, 'right'))
    await flush()
    expect(document.querySelectorAll('section[data-pane]')).toHaveLength(2)
    expect(input.isConnected).toBe(true)
    expect((input as HTMLInputElement).value).toBe('typed.txt')
    expect(paneEl('left').contains(input)).toBe(true)
  })

  it('draws each pane with its own view, and the right path bar changes only the right tab', async () => {
    // covers: Test-1066
    h = setupExplorer({
      remote: { [DIR]: [ftp('a.jpg'), ftp('b.txt', { size: 5000 })] },
      local: { [LDIR]: [local(LDIR, 'l.txt')] }
    })
    const { L, R } = await renderSplit(localLoc(LDIR), remoteLoc(DIR), {
      leftPatch: { view: 'grid' },
      rightPatch: { view: 'list' }
    })
    expect(paneEl('left').querySelector('[data-tile]')).not.toBeNull()
    expect(paneEl('right').querySelector('[data-tile]')).toBeNull()
    expect(within(paneEl('right')).getAllByRole('option')).toHaveLength(2)

    fireEvent.click(within(paneEl('right')).getByRole('button', { name: en['view.grid'] }))
    expect(tabOf(R).view).toBe('grid')
    fireEvent.click(within(paneEl('right')).getByRole('button', { name: en['view.list'] }))
    expect(tabOf(R).view).toBe('list')
    expect(tabOf(L).view).toBe('grid')

    fireEvent.click(within(paneEl('right')).getByRole('button', { name: en['sort.label'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: en['file.size'] }))
    expect(tabOf(R).sort.key).toBe('size')
    expect(tabOf(L).sort.key).toBe('name')
  })

  it('names the regions by pane in split view and by side in single view', async () => {
    // covers: Test-1067
    h = setupExplorer({
      local: { [LDIR]: [local(LDIR, 'l.txt')] },
      remote: { [DIR]: [ftp('r.jpg')] }
    })
    const { L } = await renderSplit(localLoc(LDIR), remoteLoc(DIR))
    expect(screen.getByRole('region', { name: 'Left pane: This PC' })).toBe(paneEl('left'))
    expect(screen.getByRole('region', { name: 'Right pane: example.org:21' })).toBe(paneEl('right'))

    // 같은 쪽 두 패널도 이름이 다르다
    const M = useTabsStore.getState().openTab(localLoc(LDIR), false)
    act(() => useTabsStore.setState({ split: { leftId: L, rightId: M, ratio: 0.5 } }))
    await flush()
    expect(screen.getByRole('region', { name: 'Left pane: This PC' })).toBe(paneEl('left'))
    expect(screen.getByRole('region', { name: 'Right pane: This PC' })).toBe(paneEl('right'))

    act(() => useTabsStore.getState().unsplit())
    await flush()
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual([
      en['explorer.local']
    ])
  })

  it('resizes the panes from the divider within the 280px minimum and resets on double click', async () => {
    // covers: Test-1068
    h = setupExplorer({
      local: { [LDIR]: [local(LDIR, 'l.txt')] },
      remote: { [DIR]: [ftp('r.jpg')] }
    })
    const s = useTabsStore.getState()
    const L = s.openTab(localLoc(LDIR))
    const R = s.openTab(remoteLoc(DIR), false)
    render(<Explorer />)
    await flush()
    const root = document.querySelector('[data-split-root]')
    if (!root) throw new Error('no split root')
    stubRect(root, { left: 0, top: 48, width: 1000, height: 600 })
    act(() => useTabsStore.setState({ split: { leftId: L, rightId: R, ratio: 0.5 } }))
    await flush()
    const ratio = (): number | undefined => useTabsStore.getState().split?.ratio
    const divider = screen.getByRole('separator', { name: en['split.divider'] })
    expect(divider.getAttribute('aria-orientation')).toBe('vertical')
    expect(divider.getAttribute('aria-valuenow')).toBe('50')

    fireEvent.pointerDown(divider, { clientX: 500, clientY: 300, button: 0, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 300, clientY: 300, pointerId: 1 })
    expect(ratio()).toBe(0.3)
    expect(divider.getAttribute('aria-valuenow')).toBe('30')
    fireEvent.pointerMove(window, { clientX: 100, clientY: 300, pointerId: 1 })
    expect(ratio()).toBe(0.28)
    fireEvent.pointerUp(window, { clientX: 100, clientY: 300, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 600, clientY: 300, pointerId: 1 })
    expect(ratio()).toBe(0.28)

    fireEvent.doubleClick(divider)
    expect(ratio()).toBe(0.5)

    // 창이 포커스를 잃거나 포인터 캡처를 잃으면 끌기가 끝난다(버튼을 창 밖에서 놓은 경우).
    fireEvent.pointerDown(divider, { clientX: 500, clientY: 300, button: 0, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 400, clientY: 300, pointerId: 1 })
    expect(ratio()).toBe(0.4)
    fireEvent.blur(window)
    fireEvent.pointerMove(window, { clientX: 600, clientY: 300, pointerId: 1 })
    expect(ratio()).toBe(0.4)
    expect(divider.dataset.dragging).toBeUndefined()
    fireEvent.pointerDown(divider, { clientX: 400, clientY: 300, button: 0, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 450, clientY: 300, pointerId: 1 })
    expect(ratio()).toBe(0.45)
    fireEvent.lostPointerCapture(divider)
    fireEvent.pointerMove(window, { clientX: 600, clientY: 300, pointerId: 1 })
    expect(ratio()).toBe(0.45)
    fireEvent.doubleClick(divider)

    act(() => useTabsStore.getState().setSplitRatio(0.1))
    expect(paneEl('left').style.flexBasis).toBe('28%')
    expect(ratio()).toBe(0.1)
  })

  it('keeps one menu open across panes', async () => {
    // covers: Test-1069
    h = setupExplorer({ remote: { [DIR]: [ftp('a.jpg')] } })
    const { L } = await renderSplit(remoteLoc(DIR), remoteLoc(DIR))
    fireEvent.contextMenu(listOf(L), { clientX: 50, clientY: 50 })
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.getByRole('menu').getAttribute('aria-label')).toBe('photos')

    fireEvent.contextMenu(paneOption('right', 'a.jpg'), { clientX: 700, clientY: 100 })
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.getByRole('menu').getAttribute('aria-label')).toBe('a.jpg')
    expect(paneEl('right').contains(screen.getByRole('menu'))).toBe(true)
  })

  it('moves the menu to a second right-clicked item in the same pane and leaves focus with the pane that opened the new one', async () => {
    // covers: Test-1069
    h = setupExplorer({ remote: { [DIR]: [ftp('a.jpg'), ftp('b.jpg')] } })
    const { L, R } = await renderSplit(remoteLoc(DIR), remoteLoc(DIR))
    // 같은 패널: 메뉴가 열린 채 다른 항목을 우클릭하면 그 항목의 메뉴 하나
    fireEvent.contextMenu(paneOption('left', 'a.jpg'), { clientX: 50, clientY: 50 })
    fireEvent.contextMenu(paneOption('left', 'b.jpg'), { clientX: 60, clientY: 80 })
    await flush()
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.getByRole('menu').getAttribute('aria-label')).toBe('b.jpg')

    // 다른 패널: 왼쪽 메뉴는 닫히지만 왼쪽 목록으로 포커스를 되돌려 왼쪽을 다시 활성으로 만들지 않는다.
    fireEvent.pointerDown(paneOption('right', 'a.jpg'), { button: 2 })
    fireEvent.contextMenu(paneOption('right', 'a.jpg'), { clientX: 700, clientY: 100 })
    await flush()
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(paneEl('right').contains(screen.getByRole('menu'))).toBe(true)
    expect(useTabsStore.getState().activeId).toBe(R)
    expect(document.activeElement).not.toBe(listOf(L))

    // 같은 패널의 빈 곳을 다시 우클릭해도 메뉴 하나가 그 자리로 옮겨 간다.
    fireEvent.contextMenu(listOf(R), { clientX: 700, clientY: 400 })
    fireEvent.contextMenu(listOf(R), { clientX: 710, clientY: 420 })
    await flush()
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.getByRole('menu').getAttribute('aria-label')).toBe('photos')
  })

  it('asks again for a folder preview whose request a swap cancelled while it was loading', async () => {
    // covers: Test-1064
    h = setupExplorer({ remote: { [DIR]: [ftp('sub', { dir: true })] } })
    // 실제 IntersectionObserver처럼 다음 프레임쯤(16ms) 콜백한다.
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private live = true
        constructor(private cb: IntersectionObserverCallback) {}
        observe = (el: Element): void => {
          setTimeout(() => {
            if (this.live)
              this.cb(
                [{ isIntersecting: true, target: el } as unknown as IntersectionObserverEntry],
                this as unknown as IntersectionObserver
              )
          }, 16)
        }
        disconnect = (): void => {
          this.live = false
        }
      }
    )
    // main처럼 대기 요청은 그 뷰어의 gallery:cancelAll에서 'Cancelled'로 거절된다.
    const waiting: Array<{ viewer: string; settle: (r: unknown) => void }> = []
    let answer = false
    const found = {
      success: true,
      data: { name: 'x.jpg', size: 10, modifiedAt: MODIFIED_AT, itemCount: 1 }
    }
    h.handlers['gallery:remoteFolderPreview'] = (_conn, req) =>
      new Promise((resolve) => {
        if (answer) resolve(found)
        else waiting.push({ viewer: (req as { viewerId: string }).viewerId, settle: resolve })
      })
    h.handlers['gallery:cancelAll'] = (_conn, viewer) => {
      for (let i = waiting.length - 1; i >= 0; i--)
        if (waiting[i].viewer === viewer)
          waiting.splice(i, 1)[0].settle({ success: false, error: 'Cancelled' })
      return { success: true, data: undefined }
    }
    const S = server()
    const subEntry = (): unknown =>
      useGalleryStore.getState().remoteFolderPreviews[`${S}|${DIR}/sub`]
    const frames = async (ms: number): Promise<void> => {
      await act(async () => {
        await new Promise((r) => setTimeout(r, ms))
      })
    }

    await renderSplit(remoteLoc(DIR), remoteLoc(DIR))
    await frames(40)
    expect(waiting.length).toBeGreaterThan(0)
    expect(subEntry()).toEqual({ status: 'pending' })

    answer = true
    act(() => useTabsStore.getState().swapPanes())
    await frames(40)
    await flush()
    expect(subEntry()).toMatchObject({ status: 'resolved' })
  })

  it('draws one drag ghost for the split view', async () => {
    // covers: Test-1070
    h = setupExplorer({
      remote: { [DIR]: [ftp('a.jpg')] },
      local: { [LDIR]: [local(LDIR, 'l.jpg')] }
    })
    await renderSplit(remoteLoc(DIR), localLoc(LDIR))
    fireEvent.dragStart(paneOption('right', 'l.jpg'), { dataTransfer: dt() })
    expect(useDnd.getState().items?.map((e) => e.name)).toEqual(['l.jpg'])
    expect(document.querySelectorAll('#explorer-drag-ghost')).toHaveLength(1)
  })
})
