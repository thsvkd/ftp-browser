/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { toast } from 'sonner'
import { connKey } from '@shared/connKey'
import { en } from '@renderer/i18n/locales/en'
import {
  fromFtpEntry,
  fromLocalEntry,
  locKey,
  type ExplorerEntry
} from '@renderer/lib/explorerEntry'
import { generateCacheKeyRenderer } from '@renderer/lib/cacheKey'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { useThumbnailStore } from '@renderer/stores/useThumbnailStore'
import { invokeCalls } from '@renderer/test/rendererTestUtils'
import { endDrag, useDnd } from '@renderer/components/explorer/dnd'
import { DragGhost } from '@renderer/components/explorer/DragGhost'
import {
  ftp,
  local,
  localLoc,
  remoteLoc,
  server,
  setConnection,
  setupExplorer,
  type ExplorerHarness
} from '@renderer/components/explorer/explorerTestHarness'
import { AppShell } from '@renderer/components/layout/AppShell'
import { RightRail } from '@renderer/components/layout/RightRail'
import { ShelfDock } from './ShelfDock'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() })
}))

let h: ExplorerHarness
beforeEach(() => {
  vi.clearAllMocks()
  h = setupExplorer({
    remote: { '/x': [ftp('a.jpg')], '/photos': [] },
    local: { 'C:\\dl': [local('C:\\dl', 'z.txt')] }
  })
  // 내려놓으면 더미가 활동 알약으로 날아간다(Web Animations). jsdom에는 없다.
  HTMLElement.prototype.animate = vi.fn(() => ({}) as Animation)
})
afterEach(() => {
  cleanup()
  h.restore()
  Reflect.deleteProperty(HTMLElement.prototype, 'animate')
})

const remoteItem = (name: string): ExplorerEntry => fromFtpEntry(ftp(name), '/x', server())
const shelfNames = (): string[] => useShelfStore.getState().items.map((i) => i.entry.name)
const dt = (): Record<string, unknown> => ({
  setData: vi.fn(),
  setDragImage: vi.fn(),
  effectAllowed: '',
  dropEffect: '',
  types: [],
  files: []
})
const osDt = (): Record<string, unknown> => ({
  types: ['Files'],
  files: [new File(['x'], 'a.jpg')],
  dropEffect: ''
})
/** relatedTarget 없는 dragleave를 (x, y)에서 보낸다. */
const osLeave = (x: number, y: number, target: Element = document.body): void =>
  act(() => {
    target.dispatchEvent(
      new MouseEvent('dragleave', { bubbles: true, clientX: x, clientY: y, relatedTarget: null })
    )
  })
/** 끄는 동안의 놓기 대상 — 이제 섬 루트다(shelf-island 함정 C). */
const strip = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-region="shelf-dock"][data-shelf-target]')
const island = (): HTMLElement => document.querySelector<HTMLElement>('[data-shelf-island]')!
const film = (): HTMLElement => document.querySelector<HTMLElement>('[data-shelf-film]')!
const shelfList = (): HTMLElement | null => screen.queryByRole('list', { name: en['shelf.items'] })
const dragIn = (name: string, fromShelf = false): void =>
  act(() => useDnd.setState({ items: [remoteItem(name)], over: null, thumbs: [], fromShelf }))
const row = (name: string): HTMLElement =>
  screen.getByRole('listitem', { name: new RegExp(`^${name.replace('.', '\\.')},`) })

describe('ShelfDock — the bottom floating remote', () => {
  it('draws nothing while the shelf is empty and nothing is being dragged', () => {
    // covers: Test-1247
    const { container } = render(<ShelfDock />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the collapsed card with count and size, and the existing shelf body when opened', () => {
    // covers: Test-1248
    useTabsStore.getState().openTab(localLoc('C:\\dl'))
    useShelfStore.getState().add([remoteItem('a.jpg')])
    useShelfStore.getState().setDockOpen(false)
    render(<ShelfDock />)

    const pill = screen.getByRole('button', { name: /1 item/ })
    expect(pill.textContent).toContain('1 KB')
    // 접혀 있어도 내려놓기 더미가 찾을 본체는 DOM에 남는다(함정 D) — aria 트리에서는 감춰져 있다.
    expect(document.querySelector('[data-shelf-stack]')).toBeTruthy()
    expect(screen.queryByRole('list', { name: en['shelf.items'] })).toBeNull()

    fireEvent.click(pill)
    expect(screen.getByRole('list', { name: en['shelf.items'] })).toBeTruthy()
    expect(row('a.jpg')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Download 1 to dl\s*→/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: en['shelf.clear'] })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en['shelf.collapse'] }))
    expect(screen.queryByRole('list', { name: en['shelf.items'] })).toBeNull()
  })

  it('shows the bottom strip while dragging and takes the drop on it, shelving the items', () => {
    // covers: Test-1249
    render(<ShelfDock />)
    expect(strip()).toBeNull()

    act(() =>
      useDnd.setState({ items: [remoteItem('a.jpg')], over: null, thumbs: [], fromShelf: false })
    )
    const bar = strip()
    expect(bar).toBeTruthy()
    expect(screen.getByText(en['shelf.dockHint'])).toBeTruthy()

    const over = dt()
    fireEvent.dragOver(bar as HTMLElement, { dataTransfer: over })
    expect(over.dropEffect).toBe('copy')
    fireEvent.drop(bar as HTMLElement, { dataTransfer: dt() })
    expect(shelfNames()).toEqual(['a.jpg'])
  })

  it('disappears when the drag ends elsewhere and leaves the shelf untouched', () => {
    // covers: Test-1250
    render(<ShelfDock />)
    act(() =>
      useDnd.setState({ items: [remoteItem('a.jpg')], over: null, thumbs: [], fromShelf: false })
    )
    expect(strip()).toBeTruthy()

    fireEvent.drop(document.body, { dataTransfer: dt() })
    act(() => endDrag())
    expect(strip()).toBeNull()
    expect(document.querySelector('[data-region="shelf-dock"]')).toBeNull()
    expect(shelfNames()).toEqual([])
  })

  it('drags a shelf row into useDnd with its data-path thumbnail reaching the ghost', () => {
    // covers: Test-1251
    const entry = remoteItem('a.jpg')
    const cacheKey = generateCacheKeyRenderer(server(), entry.path, entry.size, entry.modifiedAt)
    const dataUrl = 'data:image/jpeg;base64,x'
    useThumbnailStore.setState({ thumbnails: { [cacheKey]: { dataUrl, width: 1, height: 1 } } })
    useShelfStore.getState().add([entry])
    useShelfStore.getState().setDockOpen(true)
    render(
      <>
        <ShelfDock />
        <DragGhost />
      </>
    )

    const li = row('a.jpg')
    expect(li.getAttribute('data-path')).toBe(entry.path)
    expect(li.getAttribute('draggable')).toBe('true')

    fireEvent.dragStart(li, { dataTransfer: dt() })
    expect(useDnd.getState().items?.map((i) => i.name)).toEqual(['a.jpg'])
    expect(useDnd.getState().fromShelf).toBe(true)
    expect(useDnd.getState().thumbs).toEqual([dataUrl])
    expect(document.getElementById('explorer-drag-ghost')?.textContent).toContain('a.jpg')
  })

  it('removes the item from the shelf once a drag from the shelf starts a transfer elsewhere', async () => {
    // covers: Test-1252
    h.handlers['transfer:send'] = () => ({
      success: true,
      data: { batchId: 'b1', ids: ['t1'], skipped: [], conflicts: [], totalBytes: 1024 }
    })
    useTabsStore.getState().openTab(localLoc('C:\\dl'))
    useShelfStore.getState().add([remoteItem('a.jpg')])
    useShelfStore.getState().setDockOpen(true)
    render(<AppShell />)
    await screen.findByRole('listbox')

    fireEvent.dragStart(row('a.jpg'), { dataTransfer: dt() })
    const over = dt()
    fireEvent.dragOver(screen.getByRole('listbox'), { dataTransfer: over })
    expect(over.dropEffect).toBe('copy')
    fireEvent.drop(screen.getByRole('listbox'), { dataTransfer: dt() })

    await waitFor(() => expect(shelfNames()).toEqual([]))
    expect(invokeCalls(h.invoke, 'transfer:send')).toEqual([
      [server(), { direction: 'download', sources: ['/x/a.jpg'], destDir: 'C:\\dl' }]
    ])
  })

  it('keeps the item when it is dropped back on the strip without duplicating it', () => {
    // covers: Test-1253
    useShelfStore.getState().add([remoteItem('a.jpg')])
    useShelfStore.getState().setDockOpen(true)
    render(<ShelfDock />)

    fireEvent.dragStart(row('a.jpg'), { dataTransfer: dt() })
    const bar = strip()
    fireEvent.dragOver(bar as HTMLElement, { dataTransfer: dt() })
    fireEvent.drop(bar as HTMLElement, { dataTransfer: dt() })

    expect(shelfNames()).toEqual(['a.jpg'])
    expect(toast).toHaveBeenCalledWith(en['toast.alreadyOnShelf'])
  })

  it('takes OS files on the strip while an OS drag is over the app, but not on the info body', async () => {
    // covers: Test-879
    // 세그먼트(F1로 소멸) 대신 섬이 OS 드롭을 받는다. OS 드래그가 앱 안에 들어와야 섬이 뜬다.
    useTabsStore.getState().openTab(remoteLoc('/photos'))
    h.api.getPathForFile.mockReturnValue('C:\\in\\a.jpg')
    h.handlers['local:stat'] = () => ({ success: true, data: [local('C:\\in', 'a.jpg')] })
    render(
      <>
        <RightRail />
        <ShelfDock />
      </>
    )

    fireEvent.dragEnter(document.body, { dataTransfer: osDt() })
    const bar = strip()
    expect(bar).toBeTruthy()
    const over = osDt()
    fireEvent.dragOver(bar as HTMLElement, { dataTransfer: over })
    expect(over.dropEffect).toBe('copy')
    fireEvent.drop(bar as HTMLElement, { dataTransfer: osDt() })
    await waitFor(() => expect(shelfNames()).toEqual(['a.jpg']))
    expect(screen.getByRole('button', { name: /1 item/ })).toBeTruthy()

    // 전부 중복이면 토스트만 보인다 (선반은 그대로)
    vi.mocked(toast).mockClear()
    fireEvent.dragEnter(document.body, { dataTransfer: osDt() })
    const again = strip()
    fireEvent.dragOver(again as HTMLElement, { dataTransfer: osDt() })
    fireEvent.drop(again as HTMLElement, { dataTransfer: osDt() })
    await waitFor(() => expect(toast).toHaveBeenCalledWith(en['toast.alreadyOnShelf']))
    expect(shelfNames()).toEqual(['a.jpg'])

    // 정보 본문은 대상이 아니다
    const stats = invokeCalls(h.invoke, 'local:stat').length
    const region = screen.getByRole('region', { name: en['rail.info'] })
    const body = osDt()
    expect(fireEvent.dragOver(region, { dataTransfer: body })).toBe(true)
    expect(body.dropEffect).toBe('')
    fireEvent.drop(region, { dataTransfer: osDt() })
    expect(invokeCalls(h.invoke, 'local:stat')).toHaveLength(stats)
  })

  it('hides the strip when an OS drag leaves the window after an entered element unmounted', () => {
    // covers: Test-1291
    render(<ShelfDock />)
    const entered = document.createElement('div')
    document.body.append(entered)
    fireEvent.dragEnter(document.body, { dataTransfer: osDt() })
    fireEvent.dragEnter(entered, { dataTransfer: osDt() })
    expect(strip()).toBeTruthy()

    // 진입했던 요소가 끄는 도중 사라지면 짝이 되는 dragleave는 오지 않는다 — 깊이가 1에 걸린다
    entered.remove()
    // 창 밖으로 나가면 relatedTarget이 null이고 좌표가 창 경계 밖이다
    osLeave(-1, 300)
    expect(strip()).toBeNull()
  })

  it('keeps the strip on a relatedTarget-less dragleave inside the window and hides it outside', () => {
    // covers: Test-1308
    render(<ShelfDock />)
    const child = document.createElement('div')
    document.body.append(child)
    fireEvent.dragEnter(document.body, { dataTransfer: osDt() })
    fireEvent.dragEnter(child, { dataTransfer: osDt() })
    expect(strip()).toBeTruthy()

    // Chromium은 자식 경계를 넘을 때도 relatedTarget을 비워 보낼 수 있다
    osLeave(200, 300, child)
    expect(strip()).toBeTruthy()

    osLeave(200, window.innerHeight)
    expect(strip()).toBeNull()
    child.remove()
  })

  it('removes only the items of the servers whose transfer started when a shelf drag fans out', async () => {
    // covers: Test-1293
    const other = connKey('other.org', 21, '')
    setConnection(other, 'connected')
    h.handlers['transfer:send'] = (conn) =>
      conn === server()
        ? {
            success: true,
            data: { batchId: 'b1', ids: ['t1'], skipped: [], conflicts: [], totalBytes: 1024 }
          }
        : { success: false, error: 'boom' }
    useTabsStore.getState().openTab(localLoc('C:\\dl'))
    useShelfStore.getState().add([remoteItem('a.jpg'), fromFtpEntry(ftp('b.jpg'), '/x', other)])
    render(<AppShell />)
    await screen.findByRole('listbox')

    act(() =>
      useDnd.setState({
        items: useShelfStore.getState().items.map((i) => i.entry),
        over: null,
        thumbs: [],
        fromShelf: true
      })
    )
    fireEvent.dragOver(screen.getByRole('listbox'), { dataTransfer: dt() })
    fireEvent.drop(screen.getByRole('listbox'), { dataTransfer: dt() })

    await waitFor(() => expect(shelfNames()).toEqual(['b.jpg']))
  })

  it('also removes a shelf item that is already in the folder it is dropped on', async () => {
    // covers: Test-1301
    h.handlers['transfer:send'] = () => ({
      success: true,
      data: { batchId: 'b1', ids: ['t1'], skipped: [], conflicts: [], totalBytes: 1024 }
    })
    useTabsStore.getState().openTab(remoteLoc('/x'))
    // a.jpg는 이미 /x에 있고, z.txt는 업로드된다
    useShelfStore.getState().add([remoteItem('a.jpg'), fromLocalEntry(local('C:\\dl', 'z.txt'))])
    render(<AppShell />)
    await screen.findByRole('listbox')

    act(() =>
      useDnd.setState({
        items: useShelfStore.getState().items.map((i) => i.entry),
        over: null,
        thumbs: [],
        fromShelf: true
      })
    )
    fireEvent.dragOver(screen.getByRole('listbox'), { dataTransfer: dt() })
    fireEvent.drop(screen.getByRole('listbox'), { dataTransfer: dt() })

    await waitFor(() => expect(invokeCalls(h.invoke, 'transfer:send')).toHaveLength(1))
    await waitFor(() => expect(shelfNames()).toEqual([]))
  })
})

describe('ShelfDock — the pill island', () => {
  it('shows at most three thumbnails with +N in the collapsed capsule, opens from the count and keeps no hidden rows', () => {
    // covers: Test-1317
    useTabsStore.getState().openTab(localLoc('C:\\dl'))
    useShelfStore.getState().add(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'].map(remoteItem))
    render(<ShelfDock />)

    expect(document.querySelectorAll('[data-shelf-stack] [data-card]')).toHaveLength(3)
    expect(document.querySelector('[data-shelf-stack]')?.textContent).toContain('+2')
    // 접힘에는 숨긴 본체가 없다 — Tab이 들어갈 보이지 않는 행도 없다
    expect(shelfList()).toBeNull()
    expect(document.querySelectorAll('li')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: /5 items/ }))
    expect(useShelfStore.getState().dockOpen).toBe(true)
    expect(shelfList()).toBeTruthy()
  })

  it('drops the shelf into the active tab from the collapsed capsule and disables it with the reason', async () => {
    // covers: Test-1318
    h.handlers['transfer:send'] = () => ({
      success: true,
      data: { batchId: 'b1', ids: ['t1'], skipped: [], conflicts: [], totalBytes: 1024 }
    })
    useTabsStore.getState().openTab(localLoc('C:\\dl'))
    useShelfStore.getState().add([remoteItem('a.jpg')])
    render(<ShelfDock />)

    fireEvent.click(screen.getByRole('button', { name: /^Download 1 to dl\s*→/ }))
    await waitFor(() => expect(shelfNames()).toEqual([]))
    expect(invokeCalls(h.invoke, 'transfer:send')).toEqual([
      [server(), { direction: 'download', sources: ['/x/a.jpg'], destDir: 'C:\\dl' }]
    ])

    act(() => {
      useShelfStore.getState().add([remoteItem('a.jpg')])
      setConnection(server(), 'disconnected')
    })
    const blocked = screen.getByRole('button', { name: new RegExp(en['shelf.cantDropHere']) })
    expect(blocked.hasAttribute('disabled')).toBe(true)
    expect(blocked.textContent).toContain(en['send.invalidNotConnected'])
    expect(useShelfStore.getState().dockOpen).toBe(false)
  })

  it('keeps the collapsed or open form while a drag comes over a filled shelf and takes the drop on the island', () => {
    // covers: Test-1319
    useShelfStore.getState().add([remoteItem('a.jpg')])
    render(<ShelfDock />)

    dragIn('b.jpg')
    expect(shelfList()).toBeNull()
    expect(strip()).toBe(island())
    expect(island().getAttribute('data-target')).toBe('true')
    expect(screen.getByText(en['shelf.dockHint'])).toBeTruthy()
    fireEvent.dragOver(island(), { dataTransfer: dt() })
    expect(island().getAttribute('data-over')).toBe('true')
    expect(screen.getByText(en['shelf.dropHere'])).toBeTruthy()
    fireEvent.drop(island(), { dataTransfer: dt() })
    expect(shelfNames()).toEqual(['a.jpg', 'b.jpg'])
    expect(useShelfStore.getState().dockOpen).toBe(false)
    expect(shelfList()).toBeNull()

    act(() => useShelfStore.getState().setDockOpen(true))
    dragIn('c.jpg')
    expect(shelfList()).toBeTruthy()
    expect(strip()).toBe(island())
    fireEvent.dragOver(island(), { dataTransfer: dt() })
    fireEvent.drop(island(), { dataTransfer: dt() })
    expect(shelfNames()).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
    expect(shelfList()).toBeTruthy()
  })

  it('shows no target and no hint while an item from the shelf itself is dragged', () => {
    // covers: Test-1320
    useShelfStore.getState().add([remoteItem('a.jpg')])
    render(<ShelfDock />)

    dragIn('a.jpg', true)
    expect(island().getAttribute('data-target')).toBe('false')
    expect(screen.queryByText(en['shelf.dockHint'])).toBeNull()
    // 놓기는 여전히 받는다(Test-1253)
    expect(strip()).toBe(island())
  })

  it('removes a film item with a middle click only, and blocks the middle-button autoscroll', () => {
    // covers: Test-1321
    useShelfStore.getState().add([remoteItem('a.jpg'), remoteItem('b.jpg')])
    useShelfStore.getState().setDockOpen(true)
    render(<ShelfDock />)

    const down = createEvent.mouseDown(row('a.jpg'), { button: 1 })
    fireEvent(row('a.jpg'), down)
    expect(down.defaultPrevented).toBe(true)
    fireEvent.click(row('a.jpg'))
    expect(shelfNames()).toEqual(['a.jpg', 'b.jpg'])

    act(() => {
      row('a.jpg').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    })
    expect(shelfNames()).toEqual(['b.jpg'])
  })

  it('flies the thumbnails into the collapsed island when Shift+S adds more from the explorer', async () => {
    // covers: Test-1326
    useTabsStore.getState().openTab(localLoc('C:\\dl'))
    useShelfStore.getState().add([remoteItem('a.jpg')])
    render(<AppShell />)
    await screen.findByRole('listbox')

    const animate = vi.mocked(HTMLElement.prototype.animate)
    animate.mockClear()
    fireEvent.click(screen.getByRole('option', { name: /z\.txt/ }))
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'S', shiftKey: true })
    expect(shelfNames()).toEqual(['a.jpg', 'z.txt'])
    const flying = animate.mock.contexts.filter(
      (el) =>
        el instanceof HTMLElement && el.style.position === 'fixed' && el.style.zIndex === '9999'
    )
    expect(flying.length).toBeGreaterThan(0)
  })

  it('moves focus to the toggle of the new form when the island expands or collapses', () => {
    // covers: Test-1327
    useShelfStore.getState().add([remoteItem('a.jpg')])
    render(<ShelfDock />)

    const pill = screen.getByRole('button', { name: /1 item/ })
    pill.focus()
    fireEvent.click(pill)
    const collapse = screen.getByRole('button', { name: en['shelf.collapse'] })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(collapse)

    fireEvent.click(collapse)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /1 item/ }))
  })

  describe('size morph', () => {
    const SIZE: Record<string, [number, number]> = { row: [400, 54], open: [700, 272] }
    let size = SIZE
    const box = (el: HTMLElement): [number, number] =>
      el.hasAttribute('data-shelf-island') ? (size[el.dataset.mode ?? ''] ?? [0, 0]) : [0, 0]
    const widthCalls = (animate: ReturnType<typeof vi.fn>): unknown[] =>
      animate.mock.calls
        .filter((_, i) => animate.mock.contexts[i] === island())
        .map(([frames]) => frames)
        .filter((f) => Array.isArray(f) && 'width' in (f[0] as object))
    beforeEach(() => {
      size = SIZE
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get(this: HTMLElement) {
          return box(this)[0]
        }
      })
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get(this: HTMLElement) {
          return box(this)[1]
        }
      })
    })
    afterEach(() => {
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth')
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight')
      vi.unstubAllGlobals()
    })

    it('animates width and height from the capsule to the panel once, and not when unchanged or reduced', () => {
      // covers: Test-1322
      const animate = vi.fn(() => ({}) as Animation)
      HTMLElement.prototype.animate = animate
      useShelfStore.getState().add([remoteItem('a.jpg')])
      render(<ShelfDock />)

      animate.mockClear()
      fireEvent.click(screen.getByRole('button', { name: /1 item/ }))
      expect(widthCalls(animate)).toEqual([
        [
          { width: '400px', height: '54px' },
          { width: '700px', height: '272px' }
        ]
      ])

      // 크기가 같으면 걸지 않는다
      size = { row: [700, 272], open: [700, 272] }
      animate.mockClear()
      fireEvent.click(screen.getByRole('button', { name: en['shelf.collapse'] }))
      expect(widthCalls(animate)).toEqual([])

      // 동작 줄이기
      size = SIZE
      vi.stubGlobal('matchMedia', () => ({ matches: true }))
      animate.mockClear()
      fireEvent.click(screen.getByRole('button', { name: /1 item/ }))
      expect(widthCalls(animate)).toEqual([])
    })
  })

  describe('film', () => {
    /** jsdom에는 레이아웃이 없다: 필름의 스크롤 크기를 흉내 낸다. */
    function fakeScroll(el: HTMLElement, scrollWidth: number, clientWidth: number): void {
      let left = 0
      Object.defineProperties(el, {
        scrollWidth: { configurable: true, get: () => scrollWidth },
        clientWidth: { configurable: true, get: () => clientWidth },
        scrollLeft: {
          configurable: true,
          get: () => left,
          set: (v: number) => (left = Math.max(0, Math.min(v, scrollWidth - clientWidth)))
        }
      })
    }

    it('turns a vertical wheel into horizontal scroll only while the film overflows', () => {
      // covers: Test-1323
      useShelfStore.getState().add([remoteItem('a.jpg'), remoteItem('b.jpg')])
      useShelfStore.getState().setDockOpen(true)
      render(<ShelfDock />)

      fakeScroll(film(), 700, 700)
      expect(fireEvent.wheel(film(), { deltaY: 120 })).toBe(true)
      expect(film().scrollLeft).toBe(0)

      fakeScroll(film(), 1000, 700)
      expect(fireEvent.wheel(film(), { deltaY: 120 })).toBe(false)
      expect(film().scrollLeft).toBe(120)
      // 트랙패드의 가로 제스처는 그대로 둔다
      expect(fireEvent.wheel(film(), { deltaX: 40, deltaY: 10 })).toBe(true)
      expect(film().scrollLeft).toBe(120)
    })

    it('marks only the visible leading tiles as drop cards and clears the right edge when an item leaves', () => {
      // covers: Test-1328
      useShelfStore.getState().add(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].map(remoteItem))
      useShelfStore.getState().setDockOpen(true)
      render(<ShelfDock />)

      // 필름은 0~300px, 타일은 122px 간격 — shift만큼 왼쪽으로 스크롤된 것처럼 그린다
      let shift = 0
      const rect = (left: number, width: number): DOMRect =>
        ({ left, right: left + width, top: 0, bottom: 100, width, height: 100 }) as DOMRect
      const place = (el: Element, at: () => DOMRect): void => {
        Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: at })
      }
      place(film(), () => rect(0, 300))
      const tiles = (): HTMLElement[] => Array.from(film().children) as HTMLElement[]
      tiles().forEach((li, i) => place(li, () => rect(i * 122 - shift, 112)))
      const cards = (): number[] =>
        tiles().flatMap((li, i) => (li.firstElementChild?.hasAttribute('data-card') ? [i] : []))

      fakeScroll(film(), 1000, 700)
      fireEvent.scroll(film())
      expect(cards()).toEqual([0, 1, 2])
      shift = 250
      fireEvent.scroll(film())
      expect(cards()).toEqual([2, 3])
      expect(film().dataset.r).toBe('true')

      // 빼서 넘침이 사라지면(스크롤 이벤트 없이) 오른쪽 흐림이 꺼진다
      fakeScroll(film(), 700, 700)
      act(() =>
        useShelfStore.getState().remove([useShelfStore.getState().items[0].entry].map(locKey))
      )
      expect(film().dataset.r).toBe('false')
    })

    it('marks the edges that have more items and follows a newly added item to the end', () => {
      // covers: Test-1324
      useShelfStore.getState().add([remoteItem('a.jpg'), remoteItem('b.jpg')])
      useShelfStore.getState().setDockOpen(true)
      render(<ShelfDock />)

      fakeScroll(film(), 1000, 700)
      fireEvent.scroll(film())
      expect(film().dataset.l).toBe('false')
      expect(film().dataset.r).toBe('true')
      film().scrollLeft = 300
      fireEvent.scroll(film())
      expect(film().dataset.l).toBe('true')
      expect(film().dataset.r).toBe('false')

      const scrollTo = vi.fn()
      film().scrollTo = scrollTo as unknown as HTMLElement['scrollTo']
      act(() => {
        useShelfStore.getState().add([remoteItem('c.jpg')])
      })
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 1000 }))
    })
  })
})
