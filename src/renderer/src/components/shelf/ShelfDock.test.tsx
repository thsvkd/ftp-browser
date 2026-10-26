/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { en } from '@renderer/i18n/locales/en'
import { fromFtpEntry, type ExplorerEntry } from '@renderer/lib/explorerEntry'
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
const strip = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-region="shelf-dock"][data-shelf-target]')
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
    // 세그먼트(F1로 소멸) 대신 담기 띠가 OS 드롭을 받는다. OS 드래그가 앱 안에 들어와야 띠가 뜬다.
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
})
