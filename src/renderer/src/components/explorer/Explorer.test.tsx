/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  within
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { en } from '@renderer/i18n/locales/en'
import { optId } from '@renderer/lib/explorerLayout'
import { fromFtpEntry } from '@renderer/lib/explorerEntry'
import { EMPTY_FILTER } from '@renderer/lib/fileCategories'
import { gridLayout } from '@renderer/lib/gridGeometry'
import { useConfirmStore } from '@renderer/stores/useConfirmStore'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { invokeCalls } from '@renderer/test/rendererTestUtils'
import type { FtpServer } from '@shared/types/ftp'
import { ConflictSheet } from '@renderer/components/activity/ConflictSheet'
import { useDnd } from './dnd'
import {
  activeTab,
  flush,
  ftp,
  listbox,
  local,
  localLoc,
  option,
  remoteLoc,
  renderExplorer,
  selectedNames,
  server,
  setupExplorer,
  type ExplorerHarness
} from './explorerTestHarness'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() })
}))
const toastError = vi.mocked(toast.error)

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

const key = (k: string, init: Partial<KeyboardEventInit> = {}): void => {
  fireEvent.keyDown(listbox(), { key: k, ...init })
}
const menu = (): HTMLElement | null => screen.queryByRole('menu')
const pathOf = (name: string): string => option(name).getAttribute('data-path') ?? ''

/** 파일 n개짜리 원격 폴더(그리드). */
async function remoteFiles(names: string[], patch = {}): Promise<void> {
  h = setupExplorer({ remote: { [DIR]: names.map((n) => ftp(n)) } })
  await renderExplorer(remoteLoc(DIR), patch)
}

describe('Explorer — keyboard selection', () => {
  it('moves the focus cursor with arrows, extends with Shift, moves focus only with Ctrl, Ctrl+A, Esc', async () => {
    // covers: Test-791
    const names = Array.from({ length: 14 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`)
    await remoteFiles(names)
    const { cols } = gridLayout(1200, 160)

    key('ArrowRight')
    expect(selectedNames()).toEqual(['f00.txt'])
    key('ArrowDown')
    expect(selectedNames()).toEqual([names[cols]])
    key('ArrowLeft', { shiftKey: true })
    expect(selectedNames()).toEqual([names[cols - 1], names[cols]])
    key('ArrowLeft', { ctrlKey: true })
    // Ctrl은 포커스만 옮긴다: 선택은 그대로, 활성 항목은 옮겨 간다.
    expect(selectedNames()).toEqual([names[cols - 1], names[cols]])
    expect(listbox().getAttribute('aria-activedescendant')).toBe(optId(`${DIR}/${names[cols - 2]}`))

    key('a', { ctrlKey: true })
    expect(selectedNames()).toEqual(names)
    act(() => useTabsStore.getState().patchTab(activeTab().id, { query: 'f' }))
    key('Escape')
    expect(selectedNames()).toEqual([])
    expect(activeTab().query).toBe('f')
    key('Escape')
    expect(activeTab().query).toBe('')
  })

  it('opens folders with Enter, goes up and through history, reloads, and deletes the pre-confirm paths', async () => {
    // covers: Test-792
    h = setupExplorer({
      remote: {
        [DIR]: [ftp('sub', { dir: true }), ftp('a.jpg')],
        [`${DIR}/sub`]: [ftp('in.txt')],
        '/other': []
      }
    })
    await renderExplorer(remoteLoc(DIR))

    key('Home')
    key('Enter')
    await flush()
    expect(activeTab().loc.path).toBe(`${DIR}/sub`)
    key('Backspace')
    await flush()
    expect(activeTab().loc.path).toBe(DIR)
    expect(selectedNames()).toEqual(['sub'])
    key('ArrowLeft', { altKey: true })
    expect(activeTab().loc.path).toBe(`${DIR}/sub`)
    key('ArrowRight', { altKey: true })
    expect(activeTab().loc.path).toBe(DIR)
    key('ArrowUp', { altKey: true })
    expect(activeTab().loc.path).toBe('/')
    act(() => useTabsStore.getState().goBack())
    await flush()

    const lists = (): number => invokeCalls(h.invoke, 'ftp:list').filter((c) => c[0] === DIR).length
    const before = lists()
    key('F5')
    key('r', { ctrlKey: true })
    await flush()
    expect(lists()).toBe(before + 2)

    // 확인을 기다리는 동안 다른 폴더로 옮겨도 고른 시점의 경로를 지운다.
    useSettingsStore.setState({ confirmBeforeDelete: true })
    fireEvent.click(option('a.jpg'))
    key('Delete')
    await flush()
    const request = useConfirmStore.getState().request
    expect(request?.title).toBe('Delete "a.jpg"?')
    act(() => useTabsStore.getState().navigate(remoteLoc('/other')))
    await act(async () => request?.resolve(true))
    expect(invokeCalls(h.invoke, 'ftp:deleteBatch')).toEqual([
      [[{ path: `${DIR}/a.jpg`, isDirectory: false }]]
    ])
  })

  it('deletes local items through local:deleteBatch', async () => {
    // covers: Test-792
    h = setupExplorer({
      local: { [LDIR]: [local(LDIR, 'a.txt'), local(LDIR, 'docs', { dir: true })] }
    })
    await renderExplorer(localLoc(LDIR))
    key('a', { ctrlKey: true })
    key('Delete')
    await flush()
    expect(invokeCalls(h.invoke, 'local:deleteBatch')[0][0]).toEqual(
      expect.arrayContaining([
        { path: `${LDIR}\\docs`, isDirectory: true },
        { path: `${LDIR}\\a.txt`, isDirectory: false }
      ])
    )
  })
})

describe('Explorer — lightbox', () => {
  it.each([
    ['remote', 'ftp:downloadPreview'],
    ['local', 'local:preview']
  ] as const)(
    'opens the %s lightbox with Space, pages with arrows and returns focus to the tile on Esc',
    async (side, channel) => {
      // covers: Test-793
      if (side === 'remote') {
        h = setupExplorer({ remote: { [DIR]: [ftp('a.jpg'), ftp('b.jpg')] } })
        await renderExplorer(remoteLoc(DIR))
      } else {
        h = setupExplorer({ local: { [LDIR]: [local(LDIR, 'a.jpg'), local(LDIR, 'b.jpg')] } })
        await renderExplorer(localLoc(LDIR))
      }
      h.handlers[channel] = () => ({ success: true, data: 'data:image/png;base64,AA==' })
      listbox().focus()
      key('Home')
      key(' ')
      await flush()
      const dialog = screen.getByRole('dialog', { name: 'Preview: a.jpg' })
      expect(invokeCalls(h.invoke, channel)[0][0]).toEqual(
        side === 'remote'
          ? { remotePath: `${DIR}/a.jpg`, fileSize: 1024, modifiedAt: expect.any(String) }
          : `${LDIR}\\a.jpg`
      )

      fireEvent.keyDown(dialog, { key: 'ArrowRight' })
      await flush()
      expect(screen.getByRole('dialog', { name: 'Preview: b.jpg' })).toBeTruthy()

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.activeElement).toBe(listbox())
      expect(listbox().getAttribute('aria-activedescendant')).toBe(optId(pathOf('b.jpg')))
    }
  )
})

describe('Explorer — shelf and type-ahead', () => {
  it('puts the selection (or the focused item) on the shelf with Shift+S, and plain s types ahead', async () => {
    // covers: Test-794
    await remoteFiles(['apple.jpg', 'tree.jpg', '나무.jpg'])
    const shelf = (): string[] =>
      useShelfStore
        .getState()
        .items.map((i) => i.entry.name)
        .sort()
    fireEvent.click(option('apple.jpg'))
    fireEvent.click(option('tree.jpg'), { ctrlKey: true })
    key('S', { shiftKey: true })
    expect(shelf()).toEqual(['apple.jpg', 'tree.jpg'])

    // 선택이 없으면 포커스 항목을 담는다.
    key('Escape')
    expect(selectedNames()).toEqual([])
    act(() => useTabsStore.getState().patchTab(activeTab().id, { focus: pathOf('나무.jpg') }))
    key('S', { shiftKey: true })
    expect(shelf()).toEqual(['apple.jpg', 'tree.jpg', '나무.jpg'])

    act(() => useShelfStore.getState().clear())
    key('Home')
    // 그냥 s는 입력해서 고르기다: ㄴ(= s 자판)으로 시작하는 이름을 고른다.
    key('s')
    expect(selectedNames()).toEqual(['나무.jpg'])
    expect(useShelfStore.getState().items).toEqual([])
  })
})

describe('Explorer — loading, errors and empty states', () => {
  it('keeps the previous listing dimmed while reading, shows the bar after 150 ms and "Listing…" after 1 s', async () => {
    // covers: Test-796
    h = setupExplorer({ remote: { [DIR]: [ftp('a.jpg')] } })
    await renderExplorer(remoteLoc(DIR))
    let release: (v: unknown) => void = () => undefined
    h.handlers['ftp:list'] = () => new Promise((resolve) => (release = resolve))
    vi.useFakeTimers()

    act(() => useTabsStore.getState().navigate(remoteLoc(`${DIR}/sub`)))
    expect(option('a.jpg').closest('.opacity-60')).not.toBeNull()
    act(() => vi.advanceTimersByTime(100))
    expect(screen.queryByTestId('explorer-busy')).toBeNull()
    act(() => vi.advanceTimersByTime(60))
    expect(screen.queryByTestId('explorer-busy')).not.toBeNull()
    expect(screen.queryByText(/Listing…/)).toBeNull()
    act(() => vi.advanceTimersByTime(900))
    expect(screen.getByText(/Listing…/)).toBeTruthy()

    await act(async () => release({ success: true, data: { path: `${DIR}/sub`, entries: [] } }))
    expect(screen.queryByTestId('explorer-busy')).toBeNull()
    vi.useRealTimers()

    // 처음 여는 빈 탭은 스켈레톤이다.
    cleanup()
    h.handlers['ftp:list'] = () => new Promise(() => undefined)
    const { container } = await renderExplorer(remoteLoc('/fresh'))
    expect(container.querySelector('[data-skeleton]')).not.toBeNull()
  })

  it('classifies a permission error with retry and up, and keeps the last listing when the connection drops', async () => {
    // covers: Test-797
    h = setupExplorer({ remote: { [DIR]: [ftp('a.jpg')] } })
    h.handlers['ftp:list'] = (path) =>
      path === `${DIR}/locked`
        ? { success: false, error: '550 Permission denied', code: 'FTP_PERMISSION_DENIED' }
        : { success: true, data: { path, entries: [ftp('a.jpg')] } }
    await renderExplorer(remoteLoc(`${DIR}/locked`))

    expect(screen.getByText(en['listError.permission'])).toBeTruthy()
    const lists = invokeCalls(h.invoke, 'ftp:list').length
    fireEvent.click(screen.getByRole('button', { name: en['explorer.retry'] }))
    await flush()
    expect(invokeCalls(h.invoke, 'ftp:list').length).toBe(lists + 1)
    fireEvent.click(screen.getByRole('button', { name: en['explorer.goUp'] }))
    await flush()
    expect(activeTab().loc.path).toBe(DIR)
    expect(option('a.jpg')).toBeTruthy()

    act(() => useFtpStore.setState({ connectionStatus: 'error' }))
    expect(option('a.jpg').closest('.grayscale-\\[\\.4\\]')).not.toBeNull()
    expect(screen.getByText(en['explorer.staleBanner'])).toBeTruthy()
    expect(screen.getByRole('button', { name: en['explorer.reconnect'] })).toBeTruthy()

    // 지난 목록이 없는 폴더는 끊김 패널이다.
    act(() => useTabsStore.getState().navigate(remoteLoc('/never')))
    expect(screen.getByText(en['listError.lost'])).toBeTruthy()
  })

  it('tells an empty folder, a find with no match and a photo filter apart', async () => {
    // covers: Test-798
    h = setupExplorer({
      remote: { '/empty': [], [DIR]: [ftp('a.jpg'), ftp('b.txt')], '/docs': [ftp('b.txt')] }
    })
    await renderExplorer(remoteLoc('/empty'))
    expect(screen.getByText(en['explorer.empty'])).toBeTruthy()

    act(() => useTabsStore.getState().navigate(remoteLoc(DIR)))
    await flush()
    act(() => useTabsStore.getState().patchTab(activeTab().id, { query: 'zzz' }))
    expect(screen.getByText('No items match "zzz"')).toBeTruthy()

    act(() => useTabsStore.getState().navigate(remoteLoc('/docs')))
    await flush()
    act(() =>
      useTabsStore
        .getState()
        .patchTab(activeTab().id, { filter: { ...EMPTY_FILTER, categories: ['image'] } })
    )
    expect(screen.getByText('1 other file hidden by the photo filter')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['explorer.showAll'] }))
    expect(activeTab().filter).toEqual(EMPTY_FILTER)
    expect(option('b.txt')).toBeTruthy()
  })
})

describe('Explorer — inline rename and new folder', () => {
  it.each(['grid', 'list'] as const)(
    'opens the rename input inside the %s item with F2 and returns focus to the list on Enter',
    async (view) => {
      // covers: Test-804
      await remoteFiles(['a.txt', 'b.txt'], { view })
      key('Home')
      key('F2')
      const input = within(option('a.txt')).getByRole('textbox', { name: en['menu.newName'] })
      fireEvent.change(input, { target: { value: 'c.txt' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await flush()
      expect(screen.queryByRole('textbox', { name: en['menu.newName'] })).toBeNull()
      expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([[`${DIR}/a.txt`, `${DIR}/c.txt`]])
      expect(document.activeElement).toBe(listbox())
    }
  )

  it.each([
    ['remote', 'ftp:mkdir', `${DIR}/New folder (1)`],
    ['local', 'local:mkdir', `${LDIR}\\New folder (1)`]
  ] as const)(
    'creates an unused "New folder (n)" on %s with Ctrl+Shift+N and opens its inline rename',
    async (side, channel, made) => {
      // covers: Test-805
      if (side === 'remote') {
        h = setupExplorer({ remote: { [DIR]: [ftp('New folder', { dir: true })] } })
        h.handlers[channel] = () => {
          h.remote[DIR] = [...h.remote[DIR], ftp('New folder (1)', { dir: true })]
          return { success: true }
        }
        await renderExplorer(remoteLoc(DIR))
      } else {
        h = setupExplorer({ local: { [LDIR]: [local(LDIR, 'New folder', { dir: true })] } })
        h.handlers[channel] = () => {
          h.local[LDIR] = [...h.local[LDIR], local(LDIR, 'New folder (1)', { dir: true })]
          return { success: true }
        }
        await renderExplorer(localLoc(LDIR))
      }
      key('N', { ctrlKey: true, shiftKey: true })
      await flush()
      await flush()
      expect(invokeCalls(h.invoke, channel)).toEqual([[made]])
      expect(within(option('New folder (1)')).getByRole('textbox')).toBeTruthy()
    }
  )
})

describe('Explorer — drag and drop', () => {
  const dt = (init: { types?: string[]; files?: File[] } = {}): Record<string, unknown> => ({
    setData: vi.fn(),
    setDragImage: vi.fn(),
    effectAllowed: '',
    dropEffect: '',
    types: init.types ?? [],
    files: init.files ?? []
  })

  it('highlights a folder tile with the verb, sends there on drop, uses the current folder for empty space, and refuses invalid targets', async () => {
    // covers: Test-809
    h = setupExplorer({
      remote: { [DIR]: [ftp('sub', { dir: true }), ftp('a.jpg'), ftp('b.jpg')], [`${DIR}/sub`]: [] }
    })
    await renderExplorer(remoteLoc(DIR))
    fireEvent.click(option('a.jpg'))
    fireEvent.click(option('b.jpg'), { shiftKey: true })

    fireEvent.dragStart(option('a.jpg'), { dataTransfer: dt() })
    // 고스트: 개수·크기
    expect(screen.getByText('2 items · 2 KB')).toBeTruthy()
    const over = dt()
    fireEvent.dragOver(option('sub'), { dataTransfer: over })
    expect(within(option('sub')).getByText('Move 2')).toBeTruthy()
    expect(over.dropEffect).toBe('move')
    fireEvent.drop(option('sub'), { dataTransfer: dt() })
    await flush()
    expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([
      [`${DIR}/a.jpg`, `${DIR}/sub/a.jpg`],
      [`${DIR}/b.jpg`, `${DIR}/sub/b.jpg`]
    ])

    // 빈 곳에 놓으면 현재 폴더로 보낸다(다른 곳에서 끌어 온 항목).
    act(() =>
      useDnd.setState({
        items: [fromFtpEntry(ftp('x.jpg'), '/elsewhere', server())],
        over: null,
        thumbs: []
      })
    )
    fireEvent.dragOver(listbox(), { dataTransfer: dt() })
    expect(screen.getByText('Move 1 to photos')).toBeTruthy()
    fireEvent.drop(listbox(), { dataTransfer: dt() })
    await flush()
    expect(invokeCalls(h.invoke, 'ftp:rename').at(-1)).toEqual(['/elsewhere/x.jpg', `${DIR}/x.jpg`])

    // 폴더를 자기 위에 놓을 수는 없다. 고스트는 "+ folder contents"를 붙인다.
    fireEvent.dragStart(option('sub'), { dataTransfer: dt() })
    expect(screen.getByText(/\+ folder contents/)).toBeTruthy()
    const invalid = dt()
    fireEvent.dragOver(option('sub'), { dataTransfer: invalid })
    expect(invalid.dropEffect).toBe('none')
    expect(within(option('sub')).getByText(en['send.invalidIntoItself'])).toBeTruthy()
  })

  it.each([
    ['remote', 'transfer:send'],
    ['local', 'local:copyFiles']
  ] as const)('uploads or copies OS files dropped on a %s tab', async (side, channel) => {
    // covers: Test-811
    if (side === 'remote') {
      h = setupExplorer({ remote: { [DIR]: [ftp('a.jpg')] } })
      h.handlers['transfer:send'] = () => ({
        success: true,
        data: { batchId: 'b1', ids: ['1'], skipped: [], conflicts: [], totalBytes: 1 }
      })
      await renderExplorer(remoteLoc(DIR))
    } else {
      h = setupExplorer({ local: { [LDIR]: [local(LDIR, 'a.jpg')] } })
      await renderExplorer(localLoc(LDIR))
    }
    h.api.getPathForFile.mockReturnValue('C:\\in\\x.jpg')
    const file = new File(['x'], 'x.jpg')
    fireEvent.dragOver(listbox(), { dataTransfer: dt({ types: ['Files'], files: [file] }) })
    fireEvent.drop(listbox(), { dataTransfer: dt({ types: ['Files'], files: [file] }) })
    await flush()
    expect(invokeCalls(h.invoke, channel)[0]).toEqual(
      side === 'remote'
        ? [{ direction: 'upload', sources: ['C:\\in\\x.jpg'], destDir: DIR }]
        : [['C:\\in\\x.jpg'], LDIR, ['x.jpg']]
    )
  })

  it('asks before copying OS files onto an existing name in a local tab', async () => {
    // covers: Test-840
    h = setupExplorer({ local: { [LDIR]: [local(LDIR, 'x.jpg')] } })
    await renderExplorer(localLoc(LDIR))
    render(<ConflictSheet />)
    h.api.getPathForFile.mockReturnValue('C:\\in\\x.jpg')
    const file = new File(['x'], 'x.jpg')
    fireEvent.drop(listbox(), { dataTransfer: dt({ types: ['Files'], files: [file] }) })
    const sheet = await screen.findByRole('alertdialog')
    expect(invokeCalls(h.invoke, 'local:copyFiles')).toEqual([])

    fireEvent.click(within(sheet).getByRole('button', { name: 'Overwrite' }))
    await flush()
    expect(invokeCalls(h.invoke, 'local:copyFiles')).toEqual([[['C:\\in\\x.jpg'], LDIR, ['x.jpg']]])

    // 크기 0·형식 없는 OS 항목은 폴더일 수 있다: 같은 이름의 파일 위에서는 둘 다 두기·건너뛰기만
    h.api.getPathForFile.mockReturnValue('C:\\in\\x.jpg')
    fireEvent.drop(listbox(), {
      dataTransfer: dt({ types: ['Files'], files: [new File([], 'x.jpg')] })
    })
    const folder = await screen.findByRole('alertdialog')
    expect(within(folder).queryByRole('button', { name: 'Overwrite' })).toBeNull()
    expect(within(folder).getByRole('button', { name: 'Skip' })).toBeTruthy()
  })
})

describe('Explorer — remote tabs and the connection', () => {
  it('shows a connect panel for another server without listing, and the not-connected pane when offline', async () => {
    // covers: Test-823
    h = setupExplorer({ remote: { [DIR]: [ftp('a.jpg')] } })
    await renderExplorer({ side: 'remote', path: DIR, server: 'kim@nas:2121' })
    expect(invokeCalls(h.invoke, 'ftp:list')).toEqual([])
    expect(screen.getByText('This tab is a location on kim@nas:2121')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect to kim@nas:2121' }))
    expect(useServerStore.getState().address).toBe('kim@nas:2121')

    cleanup()
    h.restore()
    h = setupExplorer({ connected: false })
    const saved: FtpServer = {
      id: 1,
      name: 'Studio',
      host: 'nas',
      port: 21,
      username: '',
      secure: false,
      hasPassword: false
    }
    useServerStore.setState({ servers: [saved], connecting: false })
    await renderExplorer({ side: 'remote', path: DIR, server: 'kim@nas:2121' })
    expect(invokeCalls(h.invoke, 'ftp:list')).toEqual([])
    expect(screen.getByText(en['explorer.notConnected'])).toBeTruthy()
    expect(screen.getByRole('button', { name: /Studio/ })).toBeTruthy()
  })

  it('restores the scroll position of a tab after switching away and back', async () => {
    // covers: Test-784
    // Like a browser: scrollTop clamps to the content, and the virtualizer scrolls with scrollTo.
    const tops = new WeakMap<object, number>()
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: HTMLElement) {
        return tops.get(this) ?? 0
      },
      set(this: HTMLElement, v: number) {
        const content =
          parseFloat(
            (this.firstElementChild?.firstElementChild as HTMLElement | null)?.style.height ?? ''
          ) || 0
        tops.set(this, Math.max(0, Math.min(v, content - this.clientHeight)))
      }
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value(this: HTMLElement, o: { top: number }) {
        this.scrollTop = o.top
      }
    })
    try {
      for (const view of ['grid', 'list'] as const) {
        cleanup()
        h?.restore()
        const names = Array.from({ length: 200 }, (_, i) => `f${String(i).padStart(3, '0')}.jpg`)
        await remoteFiles(names, { view })
        const a = activeTab().id
        listbox().scrollTop = 2000
        fireEvent.scroll(listbox())
        act(() => void useTabsStore.getState().openTab(remoteLoc('/other')))
        await flush()
        act(() => useTabsStore.getState().activate(a))
        await flush()
        expect(listbox().scrollTop).toBe(2000)
      }
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollTop')
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
    }
  })
})

// ---------- 이전한 기존 테스트(§7): 우클릭 선택·닫힘·네이티브 양보·메뉴 클릭 ----------

async function localView(view: 'grid' | 'list', selected: string[] = []): Promise<void> {
  h = setupExplorer({
    local: { [LDIR]: ['a.txt', 'b.txt', 'c.txt'].map((n) => local(LDIR, n)) }
  })
  await renderExplorer(localLoc(LDIR), { view, sel: selected.map((n) => `${LDIR}\\${n}`) })
}
const deleteItem = (n: number): HTMLElement | null =>
  screen.queryByRole('menuitem', { name: n > 1 ? `Delete (${n})` : 'Delete' })

describe('Explorer — context menu (migrated)', () => {
  it('opens the menu when a list row is right-clicked', async () => {
    // covers: Test-42
    await localView('list')
    fireEvent.contextMenu(option('a.txt'))
    expect(menu()).not.toBeNull()
  })

  it('opens the menu when a grid tile is right-clicked', async () => {
    // covers: Test-43
    await localView('grid')
    fireEvent.contextMenu(option('a.txt'))
    expect(menu()).not.toBeNull()
  })

  it('opens a selection-less menu on empty space in the list', async () => {
    // covers: Test-44
    await localView('list', ['a.txt', 'b.txt'])
    fireEvent.contextMenu(listbox())
    expect(menu()).not.toBeNull()
    expect(screen.queryByRole('menuitem', { name: /^Delete/ })).toBeNull()
  })

  it('opens a selection-less menu on empty space in the grid', async () => {
    // covers: Test-67
    await localView('grid', ['a.txt', 'b.txt'])
    fireEvent.contextMenu(listbox())
    expect(menu()).not.toBeNull()
    expect(screen.queryByRole('menuitem', { name: /^Delete/ })).toBeNull()
  })

  it('selects an unselected row alone when it is right-clicked', async () => {
    // covers: Test-45
    await localView('list', ['b.txt'])
    fireEvent.contextMenu(option('a.txt'))
    expect(selectedNames()).toEqual(['a.txt'])
    expect(menu()).not.toBeNull()
  })

  it('selects an unselected tile alone when it is right-clicked', async () => {
    // covers: Test-68
    await localView('grid', ['b.txt'])
    fireEvent.contextMenu(option('a.txt'))
    expect(selectedNames()).toEqual(['a.txt'])
    expect(menu()).not.toBeNull()
  })

  it('keeps a multiple selection when one of its rows is right-clicked', async () => {
    // covers: Test-46
    await localView('list', ['a.txt', 'b.txt'])
    fireEvent.contextMenu(option('a.txt'))
    expect(selectedNames()).toEqual(['a.txt', 'b.txt'])
    expect(deleteItem(2)).not.toBeNull()
  })

  it('keeps a multiple selection when one of its tiles is right-clicked', async () => {
    // covers: Test-69
    await localView('grid', ['a.txt', 'b.txt'])
    fireEvent.contextMenu(option('a.txt'))
    expect(selectedNames()).toEqual(['a.txt', 'b.txt'])
    expect(deleteItem(2)).not.toBeNull()
  })

  it('closes the list menu on an outside click', async () => {
    // covers: Test-47
    await localView('list')
    fireEvent.contextMenu(option('a.txt'))
    fireEvent.click(document.body)
    expect(menu()).toBeNull()
  })

  it('closes the grid menu on an outside click', async () => {
    // covers: Test-70
    await localView('grid')
    fireEvent.contextMenu(option('a.txt'))
    fireEvent.click(document.body)
    expect(menu()).toBeNull()
  })

  async function yieldsToNative(view: 'grid' | 'list'): Promise<void> {
    await localView(view)
    h.api.debugToolsEnabled = true
    const plain = createEvent.contextMenu(option('a.txt'))
    fireEvent(option('a.txt'), plain)
    expect(menu()).not.toBeNull()
    expect(plain.defaultPrevented).toBe(true)
    fireEvent.click(document.body)
    expect(menu()).toBeNull()

    const shifted = createEvent.contextMenu(option('a.txt'), { shiftKey: true })
    fireEvent(option('a.txt'), shifted)
    expect(menu()).toBeNull()
    expect(shifted.defaultPrevented).toBe(false)
  }

  it('yields a list row to the native menu on Shift+right-click with debug tools', async () => {
    // covers: Test-48
    await yieldsToNative('list')
  })

  it('yields a grid tile to the native menu on Shift+right-click with debug tools', async () => {
    // covers: Test-71
    await yieldsToNative('grid')
  })

  it('keeps the whole selection when a menu item is pressed with the mouse', async () => {
    // covers: Test-80
    await localView('grid', ['a.txt', 'b.txt', 'c.txt'])
    fireEvent.contextMenu(option('a.txt'))
    await userEvent.setup().click(deleteItem(3) as HTMLElement)
    await flush()
    expect(invokeCalls(h.invoke, 'local:deleteBatch')[0][0]).toHaveLength(3)
  })

  it('keeps the menu open despite the document contextmenu dismiss listener', async () => {
    // covers: Test-114
    await localView('grid')
    fireEvent.contextMenu(option('a.txt'))
    expect(menu()).not.toBeNull()
  })
})

// ---------- 이전: 인라인 이름 바꾸기·검사·실패 표시, 삭제·확인·새로 고침 ----------

async function renameTo(name: string): Promise<void> {
  fireEvent.contextMenu(option('a.txt'))
  fireEvent.click(screen.getByRole('menuitem', { name: en['menu.rename'] }))
  const input = screen.getByRole('textbox', { name: en['menu.newName'] })
  fireEvent.change(input, { target: { value: name } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await flush()
}

describe('Explorer — remote rename (migrated)', () => {
  beforeEach(async () => {
    h = setupExplorer({ remote: { [DIR]: [ftp('a.txt')] } })
    await renderExplorer(remoteLoc(DIR))
  })

  it('renames through ftp:rename with the old and the new path', async () => {
    // covers: Test-89
    await renameTo('b.txt')
    expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([[`${DIR}/a.txt`, `${DIR}/b.txt`]])
  })

  it('rejects a name with a path separator before IPC', async () => {
    // covers: Test-90
    await renameTo('sub/child')
    expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([])
    expect(toastError).toHaveBeenCalledWith('Invalid name', {
      description: en['name.invalidRemote']
    })
  })

  it('cancels the inline input on Escape without IPC', async () => {
    // covers: Test-94
    fireEvent.contextMenu(option('a.txt'))
    fireEvent.click(screen.getByRole('menuitem', { name: en['menu.rename'] }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: en['menu.newName'] }), { key: 'Escape' })
    await flush()
    expect(screen.queryByRole('textbox', { name: en['menu.newName'] })).toBeNull()
    expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([])
  })

  it('does not rename when the name is unchanged or emptied', async () => {
    // covers: Test-95
    await renameTo('a.txt')
    await renameTo('   ')
    expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([])
  })

  it('surfaces failed rename and new folder results', async () => {
    // covers: Test-91
    h.handlers['ftp:rename'] = () => ({ success: false, error: '553 exists' })
    await renameTo('b.txt')
    expect(toastError).toHaveBeenCalledWith('Failed to rename', { description: '553 exists' })
    h.handlers['ftp:mkdir'] = () => ({ success: false, error: '550 denied' })
    key('N', { ctrlKey: true, shiftKey: true })
    await flush()
    expect(toastError).toHaveBeenCalledWith('Failed to create folder', {
      description: '550 denied'
    })
  })
})

describe('Explorer — local rename and delete (migrated)', () => {
  beforeEach(async () => {
    h = setupExplorer({
      local: { [LDIR]: [local(LDIR, 'a.txt'), local(LDIR, 'docs', { dir: true })] }
    })
    await renderExplorer(localLoc(LDIR))
  })
  const localLists = (): number =>
    invokeCalls(h.invoke, 'local:list').filter((c) => c[0] === LDIR).length

  it('renames through local:rename with the old and the new path', async () => {
    // covers: Test-56
    await renameTo('renamed.txt')
    expect(invokeCalls(h.invoke, 'local:rename')).toEqual([
      [`${LDIR}\\a.txt`, `${LDIR}\\renamed.txt`]
    ])
  })

  it('does not rename when the name is unchanged or emptied', async () => {
    // covers: Test-57
    await renameTo('a.txt')
    await renameTo('')
    expect(invokeCalls(h.invoke, 'local:rename')).toEqual([])
  })

  it('rejects a rename to a name with a path separator', async () => {
    // covers: Test-82
    for (const unsafe of ['..\\other', 'sub/child']) {
      await renameTo(unsafe)
      expect(invokeCalls(h.invoke, 'local:rename')).toEqual([])
      expect(toastError).toHaveBeenCalledWith('Invalid name', {
        description: en['name.invalidLocal']
      })
    }
    await renameTo('renamed.txt')
    expect(invokeCalls(h.invoke, 'local:rename')).toHaveLength(1)
  })

  it('reloads the listing after a rename is submitted', async () => {
    // covers: Test-73
    const before = localLists()
    await renameTo('renamed.txt')
    expect(localLists()).toBe(before + 1)
  })

  it('surfaces failed delete, rename and new folder results', async () => {
    // covers: Test-87
    h.handlers['local:deleteBatch'] = () => ({ success: false, error: 'permission denied' })
    h.handlers['local:rename'] = () => ({ success: false, error: 'Target already exists' })
    h.handlers['local:mkdir'] = () => ({ success: false, error: 'EEXIST' })
    fireEvent.click(option('a.txt'))
    key('Delete')
    await flush()
    expect(toastError).toHaveBeenCalledWith('Failed to delete', {
      description: 'permission denied'
    })
    await renameTo('b.txt')
    expect(toastError).toHaveBeenCalledWith('Failed to rename', {
      description: 'Target already exists'
    })
    key('N', { ctrlKey: true, shiftKey: true })
    await flush()
    expect(toastError).toHaveBeenCalledWith('Failed to create folder', { description: 'EEXIST' })
  })

  it('deletes the selection through local:deleteBatch with each path and directory flag', async () => {
    // covers: Test-54
    key('a', { ctrlKey: true })
    fireEvent.contextMenu(option('a.txt'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete (2)' }))
    await flush()
    const targets = invokeCalls(h.invoke, 'local:deleteBatch')[0][0]
    expect(targets).toHaveLength(2)
    expect(targets).toEqual(
      expect.arrayContaining([
        { path: `${LDIR}\\docs`, isDirectory: true },
        { path: `${LDIR}\\a.txt`, isDirectory: false }
      ])
    )
  })

  it('does not delete when the confirmation is cancelled', async () => {
    // covers: Test-55
    useSettingsStore.setState({ confirmBeforeDelete: true })
    fireEvent.click(option('a.txt'))
    key('Delete')
    await flush()
    const request = useConfirmStore.getState().request
    expect(request?.title).toBe('Delete "a.txt"?')
    await act(async () => request?.resolve(false))
    expect(invokeCalls(h.invoke, 'local:deleteBatch')).toEqual([])
  })

  it('reloads the listing and clears the selection after a delete', async () => {
    // covers: Test-72
    const before = localLists()
    fireEvent.click(option('a.txt'))
    key('Delete')
    await flush()
    expect(localLists()).toBe(before + 1)
    expect(activeTab().sel).toEqual([])
  })

  it('still clears the selection, reloads and closes the menu when the IPC call rejects', async () => {
    // covers: Test-81
    h.handlers['local:deleteBatch'] = () => Promise.reject(new Error('channel not allowed'))
    const before = localLists()
    fireEvent.contextMenu(option('a.txt'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await flush()
    expect(menu()).toBeNull()
    expect(localLists()).toBe(before + 1)
    expect(activeTab().sel).toEqual([])
    expect(toastError).toHaveBeenCalledWith('Failed to delete', {
      description: 'channel not allowed'
    })
  })
})
