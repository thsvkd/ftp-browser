/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  renderHook,
  screen,
  within
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { en } from '@renderer/i18n/locales/en'
import { ROW, optId } from '@renderer/lib/explorerLayout'
import { fromFtpEntry, fromLocalEntry } from '@renderer/lib/explorerEntry'
import { EMPTY_FILTER } from '@renderer/lib/fileCategories'
import { gridLayout } from '@renderer/lib/gridGeometry'
import { useTabEntries } from '@renderer/hooks/useTabEntries'
import { useConfirmStore } from '@renderer/stores/useConfirmStore'
import { useFileCategoryStore } from '@renderer/stores/useFileCategoryStore'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useGalleryStore } from '@renderer/stores/useGalleryStore'
import { useListingStore } from '@renderer/stores/useListingStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useActiveTab, useTabsStore } from '@renderer/stores/useTabsStore'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { invokeCalls } from '@renderer/test/rendererTestUtils'
import { connKey, MAIN_VIEWER } from '@shared/connKey'
import type { FtpServer } from '@shared/types/ftp'
import type { TransferJob } from '@shared/types/transfer'
import { ConflictSheet } from '@renderer/components/activity/ConflictSheet'
import { AppShell } from '@renderer/components/layout/AppShell'
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
  setConnection,
  setupExplorer,
  type ExplorerHarness
} from './explorerTestHarness'
import { Explorer } from './Explorer'

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
  // 저장 서버를 넣는 테스트가 다음 테스트의 자동 연결에 새지 않게 처음 상태로 되돌린다
  useServerStore.setState(useServerStore.getInitialState(), true)
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
  it('moves the selection with arrows, extends with Shift, Ctrl+A, Esc', async () => {
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

    const lists = (): number => invokeCalls(h.invoke, 'ftp:list').filter((c) => c[1] === DIR).length
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
      [server(), [{ path: `${DIR}/a.jpg`, isDirectory: false }]]
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
      expect(invokeCalls(h.invoke, channel)[0]).toEqual(
        side === 'remote'
          ? [
              server(),
              { remotePath: `${DIR}/a.jpg`, fileSize: 1024, modifiedAt: expect.any(String) }
            ]
          : [`${LDIR}\\a.jpg`]
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

  it.each([
    ['remote', 'ftp:downloadPreview'],
    ['local', 'local:preview']
  ] as const)(
    'draws the %s video lightbox as a <video> of the preview data URL',
    async (side, channel) => {
      // covers: Test-1208
      if (side === 'remote') {
        h = setupExplorer({ remote: { [DIR]: [ftp('a.webm'), ftp('b.webm')] } })
        await renderExplorer(remoteLoc(DIR))
      } else {
        h = setupExplorer({ local: { [LDIR]: [local(LDIR, 'a.webm'), local(LDIR, 'b.webm')] } })
        await renderExplorer(localLoc(LDIR))
      }
      h.handlers[channel] = () => ({ success: true, data: 'data:video/webm;base64,AA==' })
      listbox().focus()
      key('Home')
      key(' ')
      await flush()

      const dialog = screen.getByRole('dialog', { name: 'Preview: a.webm' })
      const video = dialog.querySelector('video')
      expect(invokeCalls(h.invoke, channel)).toHaveLength(1)
      expect(video).not.toBeNull()
      expect(video?.hasAttribute('controls')).toBe(true)
      expect(video?.getAttribute('src')).toBe('data:video/webm;base64,AA==')
    }
  )

  it('keeps the GIF lightbox on <img> with the image/gif data URL', async () => {
    // covers: Test-1209
    h = setupExplorer({ remote: { [DIR]: [ftp('anim.gif', { isImage: true })] } })
    await renderExplorer(remoteLoc(DIR))
    h.handlers['ftp:downloadPreview'] = () => ({
      success: true,
      data: 'data:image/gif;base64,R0lGOD'
    })
    listbox().focus()
    key('Home')
    key(' ')
    await flush()

    const dialog = screen.getByRole('dialog', { name: 'Preview: anim.gif' })
    expect(dialog.querySelector('video')).toBeNull()
    const img = dialog.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('data:image/gif;base64,R0lGOD')
  })

  it('gives Space, Enter and arrows to the video controls, and closes and pages outside them', async () => {
    // covers: Test-1210
    h = setupExplorer({ remote: { [DIR]: [ftp('a.webm'), ftp('b.webm')] } })
    await renderExplorer(remoteLoc(DIR))
    h.handlers['ftp:downloadPreview'] = () => ({
      success: true,
      data: 'data:video/webm;base64,AA=='
    })
    listbox().focus()
    key('Home')
    key(' ')
    await flush()
    const dialog = screen.getByRole('dialog', { name: 'Preview: a.webm' })
    const video = dialog.querySelector('video')
    expect(video).not.toBeNull()

    // 영상 컨트롤에 포커스가 있으면 키는 라이트박스로 새지 않는다: 목록도 안 넘기고 닫히지도 않는다.
    for (const k of [' ', 'Enter', 'ArrowRight', 'ArrowLeft']) {
      fireEvent.keyDown(video as HTMLElement, { key: k })
    }
    await flush()
    expect(screen.getByRole('dialog', { name: 'Preview: a.webm' })).toBeTruthy()

    // 영상 바깥에서는 기존 동작이 그대로여야 한다: 화살표는 넘기고 Space는 닫는다.
    fireEvent.keyDown(dialog, { key: 'ArrowRight' })
    await flush()
    expect(screen.getByRole('dialog', { name: 'Preview: b.webm' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: ' ' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the existing preview.failed notice when the preview is refused as too large', async () => {
    // covers: Test-1211
    h = setupExplorer({ remote: { [DIR]: [ftp('huge.webm')] } })
    await renderExplorer(remoteLoc(DIR))
    h.handlers['ftp:downloadPreview'] = () => ({
      success: false,
      error: 'File too large for preview'
    })
    listbox().focus()
    key('Home')
    key(' ')
    await flush()

    // 기존 안내 문구가 그대로 나온다: 새 오류 문구를 만들지 않았다(P7).
    const reason = 'File too large for preview'
    expect(screen.getByText(en['preview.failed'].replace('{{reason}}', reason))).toBeTruthy()
    expect(screen.queryByText(en['preview.none'])).toBeNull()
  })
})

describe('Explorer — shelf and type-ahead', () => {
  it('puts the selection on the shelf with Shift+S (nothing without one), and plain s types ahead', async () => {
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

    // 선택이 없으면 아무것도 담지 않는다(선택 = 포커스).
    key('Escape')
    expect(selectedNames()).toEqual([])
    key('S', { shiftKey: true })
    expect(shelf()).toEqual(['apple.jpg', 'tree.jpg'])

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
    h.handlers['ftp:list'] = (_conn, path) =>
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

    act(() => setConnection(server(), 'error'))
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
    expect(screen.getByText('No “Images” files in this folder.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['filter.clearType'] }))
    expect(activeTab().filter).toEqual(EMPTY_FILTER)
    expect(option('b.txt')).toBeTruthy()
  })

  it('names the cause in the empty panel: the type filter first, then find, then an empty folder', async () => {
    // covers: Test-946
    h = setupExplorer({
      remote: {
        '/empty': [],
        '/docs': [ftp('b.txt')],
        '/mixed': [ftp('b.txt'), ftp('c.txt')],
        '/withdir': [ftp('b.txt'), ftp('sub', { dir: true })]
      }
    })
    const setFilter = (categories: string[]): void =>
      act(() =>
        useTabsStore
          .getState()
          .patchTab(activeTab().id, { filter: { ...EMPTY_FILTER, categories } })
      )
    const go = async (path: string): Promise<void> => {
      act(() => useTabsStore.getState().navigate(remoteLoc(path)))
      await flush()
    }
    await renderExplorer(remoteLoc('/empty'))
    // (1) 정말 빈 폴더
    expect(screen.getByText(en['explorer.empty'])).toBeTruthy()

    // (2) 찾기만 걸려 일치 없음: 찾기 분기의 버튼은 `Clear filter`다(막대의 X와 패널, 둘 다 찾기를 지운다).
    await go('/mixed')
    act(() => useTabsStore.getState().patchTab(activeTab().id, { query: 'zzz' }))
    expect(screen.getByText('No items match "zzz"')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: en['filter.clear'] })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: en['filter.clearType'] })).toBeNull()
    act(() => useTabsStore.getState().patchTab(activeTab().id, { query: '' }))

    // (3) 필터로 파일이 모두 가려졌다: 필터 문구와 전용 버튼, 두 카테고리면 라벨이 둘.
    await go('/docs')
    setFilter(['image'])
    expect(screen.getByText('No “Images” files in this folder.')).toBeTruthy()
    setFilter(['image', 'video'])
    expect(screen.getByText('No “Images, Videos” files in this folder.')).toBeTruthy()
    setFilter(['image'])
    fireEvent.click(screen.getByRole('button', { name: en['filter.clearType'] }))
    expect(activeTab().filter).toEqual(EMPTY_FILTER)
    expect(option('b.txt')).toBeTruthy()

    // (4) 찾기 `b`는 일치하는데 필터가 막았다: 필터 문구가 먼저다. 두 버튼은 이름이 다르다.
    await go('/mixed')
    act(() =>
      useTabsStore.getState().patchTab(activeTab().id, {
        query: 'b',
        filter: { ...EMPTY_FILTER, categories: ['image'] }
      })
    )
    expect(screen.getByText('No “Images” files in this folder.')).toBeTruthy()
    expect(screen.queryByText(/No items match/)).toBeNull()
    expect(screen.getAllByRole('button', { name: en['filter.clear'] })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: en['filter.clearType'] })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: en['filter.clear'] }))
    expect(activeTab().query).toBe('')
    expect(activeTab().filter.categories).toEqual(['image'])
    act(() => useTabsStore.getState().patchTab(activeTab().id, { query: 'b' }))
    fireEvent.click(screen.getByRole('button', { name: en['filter.clearType'] }))
    expect(activeTab().query).toBe('b')
    expect(activeTab().filter).toEqual(EMPTY_FILTER)

    // (5) 하위 폴더가 있으면 파일이 모두 가려져도 패널 없이 폴더만 보인다.
    await go('/withdir')
    setFilter(['image'])
    expect(option('sub')).toBeTruthy()
    expect(screen.queryByText(/files in this folder/)).toBeNull()
    expect(screen.queryByText(en['explorer.empty'])).toBeNull()
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
      expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([
        [server(), `${DIR}/a.txt`, `${DIR}/c.txt`]
      ])
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
      expect(invokeCalls(h.invoke, channel)).toEqual([
        side === 'remote' ? [server(), made] : [made]
      ])
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
      [server(), `${DIR}/a.jpg`, `${DIR}/sub/a.jpg`],
      [server(), `${DIR}/b.jpg`, `${DIR}/sub/b.jpg`]
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
    expect(invokeCalls(h.invoke, 'ftp:rename').at(-1)).toEqual([
      server(),
      '/elsewhere/x.jpg',
      `${DIR}/x.jpg`
    ])

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
        ? [server(), { direction: 'upload', sources: ['C:\\in\\x.jpg'], destDir: DIR }]
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

    fireEvent.click(within(sheet).getByRole('radio', { name: 'Overwrite' }))
    fireEvent.click(within(sheet).getByRole('button', { name: 'Confirm' }))
    await flush()
    expect(invokeCalls(h.invoke, 'local:copyFiles')).toEqual([[['C:\\in\\x.jpg'], LDIR, ['x.jpg']]])

    // 크기 0·형식 없는 OS 항목은 폴더일 수 있다: 같은 이름의 파일 위에서는 둘 다 두기·건너뛰기만
    h.api.getPathForFile.mockReturnValue('C:\\in\\x.jpg')
    fireEvent.drop(listbox(), {
      dataTransfer: dt({ types: ['Files'], files: [new File([], 'x.jpg')] })
    })
    const folder = await screen.findByRole('alertdialog')
    expect(within(folder).queryByRole('radio', { name: 'Overwrite' })).toBeNull()
    expect(within(folder).getByRole('radio', { name: 'Skip' })).toBeTruthy()
  })

  it('shows the transfer pill and the shelf drop strip together, and shelves on the strip', async () => {
    // covers: Test-1256
    h = setupExplorer({ remote: { [DIR]: [ftp('a.jpg')] } })
    useTabsStore.getState().openTab(remoteLoc(DIR))
    render(<AppShell />)
    await screen.findByRole('listbox')

    // 다른 폴더에서 끌던 중: 탐색기의 기존 전송 안내 알약과 새 담기 띠가 함께 뜬다(함정 B).
    act(() =>
      useDnd.setState({
        items: [fromFtpEntry(ftp('x.jpg'), '/elsewhere', server())],
        over: null,
        thumbs: [],
        fromShelf: false
      })
    )
    fireEvent.dragOver(listbox(), { dataTransfer: dt() })
    expect(screen.getByText('Move 1 to photos')).toBeTruthy()
    const bar = document.querySelector<HTMLElement>('[data-region="shelf-dock"][data-shelf-target]')
    expect(bar).toBeTruthy()
    expect(screen.getByText(en['shelf.dockHint'])).toBeTruthy()

    const over = dt()
    fireEvent.dragOver(bar as HTMLElement, { dataTransfer: over })
    expect(over.dropEffect).toBe('copy')
    fireEvent.drop(bar as HTMLElement, { dataTransfer: dt() })
    expect(useShelfStore.getState().items.map((i) => i.entry.name)).toEqual(['x.jpg'])
  })
})

describe('Explorer — split zones for a server drag', () => {
  const zoneDt = (): Record<string, unknown> => ({
    types: [],
    files: [],
    dropEffect: '',
    setData: vi.fn(),
    setDragImage: vi.fn(),
    effectAllowed: ''
  })
  const OFFICE: FtpServer = {
    id: 2,
    name: 'Office',
    host: 'ftp.office.lan',
    port: 2121,
    username: 'kim',
    hasPassword: true,
    secure: false
  }

  it('highlights only the hovered half with the split hint while a server is dragged', async () => {
    // covers: Test-1258
    h = setupExplorer({ remote: { [DIR]: [ftp('a.jpg')] } })
    await renderExplorer(remoteLoc(DIR))

    // 항목을 끌 때는 분할 자리가 없다(M14·M15의 구분).
    act(() =>
      useDnd.setState({
        items: [fromFtpEntry(ftp('a.jpg'), DIR, server())],
        over: null,
        thumbs: []
      })
    )
    expect(screen.queryByTestId('split-zones')).toBeNull()

    act(() =>
      useDnd.setState({ server: OFFICE, items: null, over: null, thumbs: [], fromShelf: false })
    )
    const zones = screen.getByTestId('split-zones')
    const left = within(zones).getByTestId('split-left')
    const right = within(zones).getByTestId('split-right')

    fireEvent.dragOver(left, { dataTransfer: zoneDt() })
    expect(within(left).getByText(en['split.dropHint'])).toBeTruthy()
    expect(within(right).queryByText(en['split.dropHint'])).toBeNull()
    expect(useDnd.getState().over).toBe('split:left')

    fireEvent.dragOver(right, { dataTransfer: zoneDt() })
    expect(within(right).getByText(en['split.dropHint'])).toBeTruthy()
    expect(within(left).queryByText(en['split.dropHint'])).toBeNull()
    expect(useDnd.getState().over).toBe('split:right')
  })
})

describe('Explorer — drag-and-drop upload progress in the destination tab', () => {
  const dt = (files: File[] = []): Record<string, unknown> => ({
    setData: vi.fn(),
    setDragImage: vi.fn(),
    effectAllowed: '',
    dropEffect: '',
    types: files.length ? ['Files'] : [],
    files
  })
  const sent = (): void => {
    h.handlers['transfer:send'] = () => ({
      success: true,
      data: { batchId: 'b1', ids: ['j1'], skipped: [], conflicts: [], totalBytes: 100 }
    })
  }
  const uploading = (remotePath: string): TransferJob => ({
    id: 'j1',
    batchId: 'b1',
    server: server(),
    direction: 'upload',
    localPath: `C:\\in\\${remotePath.split('/').pop()}`,
    remotePath,
    fileName: remotePath.split('/').pop() ?? '',
    totalBytes: 100,
    transferredBytes: 40,
    status: 'active'
  })
  const ringOn = (name: string): string | null | undefined =>
    option(name).querySelector('[data-transfer-ring]')?.getAttribute('data-transfer-ring')

  it('rings the folder tile a Finder folder is uploaded into', async () => {
    // covers: Test-1096
    h = setupExplorer({ remote: { [DIR]: [ftp('folder', { dir: true })] } })
    sent()
    await renderExplorer(remoteLoc(DIR))
    h.api.getPathForFile.mockReturnValue('C:\\in\\folder')
    const file = new File([], 'folder')
    fireEvent.dragOver(listbox(), { dataTransfer: dt([file]) })
    fireEvent.drop(listbox(), { dataTransfer: dt([file]) })
    await flush()
    expect(invokeCalls(h.invoke, 'transfer:send')).toEqual([
      [server(), { direction: 'upload', sources: ['C:\\in\\folder'], destDir: DIR }]
    ])

    act(() =>
      useTransferStore
        .getState()
        .applyUpdate({ upserts: [uploading(`${DIR}/folder/big.bin`)], removedIds: [] })
    )
    expect(ringOn('folder')).toBe('active')

    // 새 폴더: 큐의 MKD가 알린 mkdir(ftp:remoteChanged → 목록 무효화)으로 타일이 생기고, 그 타일에 고리가 붙는다
    act(() => useTransferStore.setState({ jobs: [] }))
    h.api.getPathForFile.mockReturnValue('C:\\in\\fresh')
    fireEvent.drop(listbox(), { dataTransfer: dt([new File([], 'fresh')]) })
    await flush()
    h.remote[DIR] = [ftp('folder', { dir: true }), ftp('fresh', { dir: true })]
    act(() => useListingStore.getState().invalidate('remote', server(), DIR))
    await flush()
    act(() =>
      useTransferStore
        .getState()
        .applyUpdate({ upserts: [uploading(`${DIR}/fresh/big.bin`)], removedIds: [] })
    )
    expect(ringOn('fresh')).toBe('active')
  })

  it('rings the remote folder tile local items were dragged onto', async () => {
    // covers: Test-1097
    h = setupExplorer({ remote: { [DIR]: [ftp('sub', { dir: true })], [`${DIR}/sub`]: [] } })
    sent()
    await renderExplorer(remoteLoc(DIR))
    act(() =>
      useDnd.setState({
        items: [fromLocalEntry(local(LDIR, 'x.jpg'))],
        over: null,
        thumbs: []
      })
    )
    fireEvent.dragOver(option('sub'), { dataTransfer: dt() })
    fireEvent.drop(option('sub'), { dataTransfer: dt() })
    await flush()
    expect(invokeCalls(h.invoke, 'transfer:send')).toEqual([
      [server(), { direction: 'upload', sources: [`${LDIR}\\x.jpg`], destDir: `${DIR}/sub` }]
    ])

    act(() =>
      useTransferStore
        .getState()
        .applyUpdate({ upserts: [uploading(`${DIR}/sub/x.jpg`)], removedIds: [] })
    )
    expect(ringOn('sub')).toBe('active')
  })

  it('does not fly a card to the activity pill when a cross-side drop starts a transfer', async () => {
    // covers: Test-1119
    const animate = vi.fn(() => ({ onfinish: null }) as unknown as Animation)
    Element.prototype.animate = animate
    const pill = document.createElement('button')
    pill.setAttribute('data-activity-target', '')
    document.body.appendChild(pill)
    try {
      h = setupExplorer({ remote: { [DIR]: [ftp('sub', { dir: true })], [`${DIR}/sub`]: [] } })
      sent()
      await renderExplorer(remoteLoc(DIR))

      // Finder에서 끌어 온 파일: 업로드
      h.api.getPathForFile.mockReturnValue('C:\\in\\x.jpg')
      fireEvent.drop(listbox(), { dataTransfer: dt([new File(['x'], 'x.jpg')]) })
      await flush()
      expect(invokeCalls(h.invoke, 'transfer:send')).toHaveLength(1)

      // 로컬 탭에서 끌어 온 항목을 원격 폴더 타일에: 업로드
      act(() =>
        useDnd.setState({ items: [fromLocalEntry(local(LDIR, 'y.jpg'))], over: null, thumbs: [] })
      )
      fireEvent.drop(option('sub'), { dataTransfer: dt() })
      await flush()
      expect(invokeCalls(h.invoke, 'transfer:send')).toHaveLength(2)
      expect(animate).not.toHaveBeenCalled()
    } finally {
      pill.remove()
      delete (Element.prototype as Partial<Element>).animate
    }
  })
})

describe('Explorer — remote tabs and the connection', () => {
  it("lists each connected server's tab and gives an unconnected server its own panel", async () => {
    // covers: Test-1018
    const B = 'bob@b.lan:2121'
    const C = 'carol@c.lan:21'
    h = setupExplorer({ remote: { [DIR]: [ftp('a.jpg')] } })
    setConnection(B, 'connected')
    h.handlers['ftp:list'] = (conn, path) =>
      conn === B
        ? { success: true, data: { path, entries: [ftp('b.jpg')] } }
        : { success: false, error: 'wrong server', code: 'FTP_NOT_CONNECTED' }
    await renderExplorer({ side: 'remote', path: DIR, server: B })
    expect(invokeCalls(h.invoke, 'ftp:list')).toEqual([[B, DIR]])
    expect(option('b.jpg')).toBeTruthy()

    // 연결 안 된 C: 그 서버 전용 패널과 연결 버튼(누르면 C 연결 흐름)
    act(() => useTabsStore.getState().navigate({ side: 'remote', path: DIR, server: C }))
    await flush()
    expect(invokeCalls(h.invoke, 'ftp:list')).toEqual([[B, DIR]])
    expect(screen.getByText(`Not connected to ${C}`)).toBeTruthy()
    const connect = screen.getByRole('button', { name: `Connect to ${C}` }) as HTMLButtonElement
    expect(connect.disabled).toBe(false)
    fireEvent.click(connect)
    expect(useServerStore.getState().address).toBe(C)

    // C가 연결 중: 버튼 비활성 + 회전 표시
    act(() => setConnection(C, 'connecting'))
    const busy = screen.getByRole('button', { name: `Connect to ${C}` }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect(busy.querySelector('.spin')).toBeTruthy()

    // C가 끊김: 지난 목록이 있으면 흐리게 + 배너, 없으면 끊김 패널
    act(() => {
      useListingStore
        .getState()
        .put({ side: 'remote', path: DIR, server: C }, [fromFtpEntry(ftp('c.jpg'), DIR, C)])
      setConnection(C, 'error')
    })
    expect(option('c.jpg').closest('.grayscale-\\[\\.4\\]')).not.toBeNull()
    expect(screen.getByText(en['explorer.staleBanner'])).toBeTruthy()
    act(() => useTabsStore.getState().navigate({ side: 'remote', path: '/never', server: C }))
    expect(screen.getByText(en['listError.lost'])).toBeTruthy()
    expect(screen.queryByText(/This tab is a location on/)).toBeNull()
  })

  it('auto-connects a saved server with a saved password once each time its tab is shown', async () => {
    // covers: Test-1019
    const C = 'carol@c.lan:21'
    const saved: FtpServer = {
      id: 7,
      name: 'Studio',
      host: 'c.lan',
      port: 21,
      username: 'carol',
      secure: false,
      hasPassword: true
    }
    h = setupExplorer({ remote: { [DIR]: [ftp('a.jpg')] } })
    const draft = { ...useServerStore.getState().draft, host: 'toolbar.lan' }
    useServerStore.setState({ servers: [saved], draft, connecting: false })
    const connects = (): unknown[][] => invokeCalls(h.invoke, 'ftp:connect')
    const home = useTabsStore.getState().openTab(localLoc(LDIR))
    h.local[LDIR] = []
    render(<Explorer />)
    await flush()
    const show = async (id: string): Promise<void> => {
      act(() => useTabsStore.getState().activate(id))
      await flush()
    }

    const tabC = useTabsStore.getState().openTab({ side: 'remote', path: DIR, server: C }, false)
    await show(tabC)
    expect(connects()).toHaveLength(1)
    expect(connects()[0][0]).toMatchObject({
      id: 7,
      host: 'c.lan',
      port: 21,
      user: 'carol',
      savedPasswordOf: 7
    })
    expect(useServerStore.getState().draft).toBe(draft)
    expect(useServerStore.getState().connecting).toBe(false)
    expect(useFtpStore.getState().connections[C].status).toBe('connected')

    // 보는 중에 C를 끊으면 다시 잇지 않는다. 다른 탭에 갔다 돌아오면 한 번 더
    await act(() => useFtpStore.getState().disconnect(C))
    await flush()
    expect(connects()).toHaveLength(1)
    await show(home)
    await show(tabC)
    expect(connects()).toHaveLength(2)

    // 실패한 뒤 같은 탭에 머무는 동안은 다시 부르지 않는다
    h.handlers['ftp:connect'] = () => ({ success: false, error: '530 Login incorrect' })
    await act(() => useFtpStore.getState().disconnect(C))
    await show(home)
    await show(tabC)
    expect(connects()).toHaveLength(3)
    act(() => setConnection(C, 'disconnected'))
    await flush()
    expect(connects()).toHaveLength(3)

    // 끊김(error)으로는 부르지 않는다
    act(() => setConnection(C, 'error'))
    await show(home)
    await show(tabC)
    expect(connects()).toHaveLength(3)

    // 저장 비밀번호가 없으면 0회
    useServerStore.setState({ servers: [{ ...saved, hasPassword: false }] })
    act(() => setConnection(C, 'disconnected'))
    await show(home)
    await show(tabC)
    expect(connects()).toHaveLength(3)
  })

  it('does not auto-connect a server that is already connecting', async () => {
    // covers: Test-1034
    const C = 'carol@c.lan:21'
    h = setupExplorer({ remote: { [DIR]: [ftp('a.jpg')] } })
    useServerStore.setState({
      servers: [
        {
          id: 7,
          name: 'Studio',
          host: 'c.lan',
          port: 21,
          username: 'carol',
          secure: false,
          hasPassword: true
        }
      ],
      connecting: false
    })
    setConnection(C, 'connecting')
    await renderExplorer({ side: 'remote', path: DIR, server: C })
    expect(invokeCalls(h.invoke, 'ftp:connect')).toEqual([])
    act(() => setConnection(C, 'connected'))
    await flush()
    act(() => setConnection(C, 'disconnected'))
    await flush()
    expect(invokeCalls(h.invoke, 'ftp:connect')).toEqual([])
  })

  it("runs every remote action of a tab on that tab's connection", async () => {
    // covers: Test-1028
    const B = 'bob@b.lan:2121'
    h = setupExplorer({ remote: { [DIR]: [ftp('a.jpg'), ftp('b.jpg')] } })
    setConnection(B, 'connected')
    h.handlers['ftp:downloadPreview'] = () => ({
      success: true,
      data: 'data:image/png;base64,AA=='
    })
    h.handlers['transfer:send'] = () => ({
      success: true,
      data: { batchId: 'b1', ids: ['1'], skipped: [], conflicts: [], totalBytes: 1 }
    })
    await renderExplorer({ side: 'remote', path: DIR, server: B })
    expect(invokeCalls(h.invoke, 'ftp:list')).toEqual([[B, DIR]])

    // 라이트박스
    listbox().focus()
    key('Home')
    key(' ')
    await flush()
    expect(invokeCalls(h.invoke, 'ftp:downloadPreview')[0][0]).toBe(B)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await flush()

    // 이름 바꾸기
    key('Home')
    key('F2')
    const input = within(option('a.jpg')).getByRole('textbox', { name: en['menu.newName'] })
    fireEvent.change(input, { target: { value: 'c.jpg' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([[B, `${DIR}/a.jpg`, `${DIR}/c.jpg`]])

    // 삭제
    fireEvent.click(option('b.jpg'))
    key('Delete')
    await flush()
    expect(invokeCalls(h.invoke, 'ftp:deleteBatch')).toEqual([
      [B, [{ path: `${DIR}/b.jpg`, isDirectory: false }]]
    ])

    // OS 파일 드롭은 그 서버로 업로드
    h.api.getPathForFile.mockReturnValue('C:\\in\\x.jpg')
    const file = new File(['x'], 'x.jpg')
    const drop = { types: ['Files'], files: [file], dropEffect: '' }
    fireEvent.drop(listbox(), { dataTransfer: drop })
    await flush()
    expect(invokeCalls(h.invoke, 'transfer:send')).toEqual([
      [B, { direction: 'upload', sources: ['C:\\in\\x.jpg'], destDir: DIR }]
    ])

    // 새 폴더
    key('N', { ctrlKey: true, shiftKey: true })
    await flush()
    expect(invokeCalls(h.invoke, 'ftp:mkdir')).toEqual([[B, `${DIR}/New folder`]])
    expect(
      [...h.invoke.mock.calls].filter((c) => String(c[0]).startsWith('ftp:') && c[1] === server())
    ).toEqual([])
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
    expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([
      [server(), `${DIR}/a.txt`, `${DIR}/b.txt`]
    ])
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

// ---------- 이미 있는 이름 경고(rename-name-taken N1~N5) ----------

describe('Explorer — rename to a name that is already taken', () => {
  const startRename = (name = 'a.txt'): HTMLElement => {
    fireEvent.contextMenu(option(name))
    fireEvent.click(screen.getByRole('menuitem', { name: en['menu.rename'] }))
    return screen.getByRole('textbox', { name: en['menu.newName'] })
  }
  const warning = (): HTMLElement | null => screen.queryByRole('alert')

  it.each([
    [
      'remote',
      async (): Promise<void> => {
        h = setupExplorer({
          remote: { [DIR]: [ftp('a.txt'), ftp('b.txt'), ftp('docs', { dir: true })] }
        })
        await renderExplorer(remoteLoc(DIR))
      }
    ],
    [
      'local',
      async (): Promise<void> => {
        h = setupExplorer({
          local: {
            [LDIR]: [local(LDIR, 'a.txt'), local(LDIR, 'b.txt'), local(LDIR, 'docs', { dir: true })]
          }
        })
        await renderExplorer(localLoc(LDIR))
      }
    ]
  ] as const)('warns on %s as soon as the name matches another item', async (_side, open) => {
    // covers: Test-1330
    await open()
    const input = startRename()
    expect(warning()).toBeNull()
    for (const taken of ['b.txt', 'docs', ' docs ']) {
      fireEvent.change(input, { target: { value: taken } })
      expect(warning()).not.toBeNull()
      expect(warning()?.textContent).toBe(en['name.taken'])
      expect(input.getAttribute('aria-invalid')).toBe('true')
    }
    for (const free of ['c.txt', 'a.txt']) {
      fireEvent.change(input, { target: { value: free } })
      expect(warning()).toBeNull()
      expect(input.getAttribute('aria-invalid')).toBe('false')
    }
  })

  describe('on a remote folder', () => {
    beforeEach(async () => {
      h = setupExplorer({ remote: { [DIR]: [ftp('a.txt'), ftp('docs', { dir: true })] } })
      await renderExplorer(remoteLoc(DIR))
    })

    it('keeps editing on Enter without sending the rename', async () => {
      // covers: Test-1331
      const input = startRename()
      fireEvent.change(input, { target: { value: 'docs' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await flush()
      expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([])
      expect(screen.getByRole('textbox', { name: en['menu.newName'] })).toBe(input)
      expect(warning()).not.toBeNull()
    })

    it('cancels on blur without IPC or an error toast', async () => {
      // covers: Test-1332
      const input = startRename()
      fireEvent.change(input, { target: { value: 'docs' } })
      fireEvent.blur(input)
      await flush()
      expect(screen.queryByRole('textbox', { name: en['menu.newName'] })).toBeNull()
      expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([])
      expect(toastError).not.toHaveBeenCalled()
      expect(option('a.txt')).toBeTruthy()
    })
  })

  it('counts items hidden by the hidden-files setting and by find', async () => {
    // covers: Test-1333
    h = setupExplorer({ remote: { [DIR]: [ftp('a.txt'), ftp('.secret'), ftp('notes.md')] } })
    await renderExplorer(remoteLoc(DIR))
    act(() => useTabsStore.getState().patchTab(activeTab().id, { query: 'a' }))
    expect(screen.queryByRole('option', { name: /notes\.md/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /\.secret/ })).toBeNull()
    const input = startRename()
    for (const taken of ['.secret', 'notes.md']) {
      fireEvent.change(input, { target: { value: taken } })
      expect(warning()).not.toBeNull()
      expect(warning()?.textContent).toBe(en['name.taken'])
    }
  })

  it('treats the untouched original name as free even with surrounding spaces', async () => {
    // covers: Test-1334
    h = setupExplorer({ remote: { [DIR]: [ftp(' a.txt'), ftp('a.txt')] } })
    await renderExplorer(remoteLoc(DIR))
    const input = startRename(' a.txt')
    expect(warning()).toBeNull()
    expect(input.getAttribute('aria-invalid')).toBe('false')
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([])
  })

  it('keeps editing when the window loses focus', async () => {
    // covers: Test-1336
    h = setupExplorer({ remote: { [DIR]: [ftp('a.txt'), ftp('docs', { dir: true })] } })
    await renderExplorer(remoteLoc(DIR))
    const input = startRename()
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    onTestFinished(() => hasFocus.mockRestore())
    for (const typed of ['docs', 'c.txt']) {
      fireEvent.change(input, { target: { value: typed } })
      fireEvent.blur(input)
      await flush()
      expect(screen.getByRole('textbox', { name: en['menu.newName'] })).toBe(input)
    }
    expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([])

    // 창으로 돌아온 뒤에는 바깥 클릭이 다시 제출한다
    hasFocus.mockRestore()
    fireEvent.blur(input)
    await flush()
    expect(screen.queryByRole('textbox', { name: en['menu.newName'] })).toBeNull()
    expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([
      [server(), `${DIR}/a.txt`, `${DIR}/c.txt`]
    ])
  })

  it('closes an editor whose item leaves the folder while the window is away', async () => {
    // covers: Test-1337
    h = setupExplorer({ remote: { [DIR]: [ftp('a.txt'), ftp('docs', { dir: true })] } })
    await renderExplorer(remoteLoc(DIR))
    const input = startRename()
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    onTestFinished(() => hasFocus.mockRestore())
    fireEvent.change(input, { target: { value: 'c.txt' } })
    fireEvent.blur(input)

    h.remote[DIR] = [ftp('docs', { dir: true })]
    key('F5')
    await flush()
    expect(screen.queryByRole('textbox', { name: en['menu.newName'] })).toBeNull()
    expect(document.activeElement).not.toBe(document.body)

    // 같은 이름이 다시 나타나도 편집이 저절로 열리지 않는다
    h.remote[DIR] = [ftp('a.txt'), ftp('docs', { dir: true })]
    key('F5')
    await flush()
    expect(option('a.txt')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: en['menu.newName'] })).toBeNull()
    expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([])
  })

  it('keeps the new folder editor open when its own reload is superseded by another', async () => {
    // covers: Test-1338
    h = setupExplorer({ remote: { [DIR]: [ftp('a.txt')] } })
    await renderExplorer(remoteLoc(DIR))
    const waits: Array<() => void> = []
    h.handlers['ftp:mkdir'] = () => {
      h.remote[DIR] = [...h.remote[DIR], ftp('New folder', { dir: true })]
      return { success: true }
    }
    h.handlers['ftp:list'] = (_conn, path) =>
      new Promise((resolve) =>
        waits.push(() => resolve({ success: true, data: { path, entries: h.remote[DIR] } }))
      )
    key('N', { ctrlKey: true, shiftKey: true })
    await flush()
    await flush()
    expect(waits).toHaveLength(1)
    // mkdir 알림(ftp:remoteChanged)의 무효화가 두 번째 읽기를 시작해 첫 결과를 버리게 한다
    act(() => useListingStore.getState().invalidate('remote', server(), DIR))
    await act(async () => waits[0]())
    await flush()
    await act(async () => waits[1]())
    await flush()

    expect(within(option('New folder')).getByRole('textbox')).toBeTruthy()
  })

  it('closes a new folder editor that find hides and never reopens it', async () => {
    // covers: Test-1339
    h = setupExplorer({ remote: { [DIR]: [ftp('a.jpg')] } })
    h.handlers['ftp:mkdir'] = () => {
      h.remote[DIR] = [...h.remote[DIR], ftp('New folder', { dir: true })]
      return { success: true }
    }
    await renderExplorer(remoteLoc(DIR))
    act(() => useTabsStore.getState().patchTab(activeTab().id, { query: 'jpg' }))
    key('N', { ctrlKey: true, shiftKey: true })
    await flush()
    await flush()
    expect(invokeCalls(h.invoke, 'ftp:mkdir')).toHaveLength(1)

    act(() => useTabsStore.getState().patchTab(activeTab().id, { query: '' }))
    await flush()
    expect(option('New folder')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: en['menu.newName'] })).toBeNull()
  })

  it('shows the warning as a described, click-through note scrolled into view', async () => {
    // covers: Test-1335
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    onTestFinished(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    })
    h = setupExplorer({ remote: { [DIR]: [ftp('a.txt'), ftp('docs', { dir: true })] } })
    await renderExplorer(remoteLoc(DIR))
    const input = startRename()
    fireEvent.change(input, { target: { value: 'docs' } })
    const note = warning() as HTMLElement
    expect(input.getAttribute('aria-describedby')).toBe(note.id)
    expect(note.className).toContain('pointer-events-none')
    expect(note.className).toContain('[overflow-wrap:anywhere]')
    expect(note.className).toContain('min-w-[5rem]')
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scroll.mock.contexts.at(-1)).toBe(note)
    // 경고가 이어지는 동안 입력할 때마다 스크롤하지 않는다
    fireEvent.change(input, { target: { value: 'docs ' } })
    fireEvent.change(input, { target: { value: ' docs' } })
    expect(scroll).toHaveBeenCalledTimes(1)
  })
})

// ---------- 선택 = 포커스(explorer-menu-and-focus F1~F10) ----------

const activeId = (): string | null => listbox().getAttribute('aria-activedescendant')
const selectionOf = (): { sel: string[]; anchor: string | null; focus: string | null } => {
  const { sel, anchor, focus } = activeTab()
  return { sel, anchor, focus }
}
const CLEARED = { sel: [], anchor: null, focus: null }
const noneSelected = (): boolean =>
  screen.getAllByRole('option').every((o) => o.getAttribute('aria-selected') === 'false')
/** 항목 밖(안쪽 컨테이너)의 왼쪽 mousedown. 마퀴의 window 리스너도 mouseup으로 걷는다. */
const pressEmpty = (init: MouseEventInit = {}): void => {
  fireEvent.mouseDown(option('a.txt').parentElement as HTMLElement, init)
  fireEvent.mouseUp(window)
}
const FIVE = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']
const p = (name: string): string => `${DIR}/${name}`

describe('Explorer — selection is the focus', () => {
  it('releases the focus with the selection even when the delete fails', async () => {
    // covers: Test-856
    h = setupExplorer({
      local: { [LDIR]: [local(LDIR, 'a.txt'), local(LDIR, 'd', { dir: true })] }
    })
    await renderExplorer(localLoc(LDIR))
    const failThenCheck = async (): Promise<void> => {
      fireEvent.click(option('d'))
      expect(activeId()).toBe(optId(pathOf('d')))
      key('Delete')
      await flush()
      expect(toastError).toHaveBeenCalledWith('Failed to delete', expect.anything())
      expect(selectionOf()).toEqual(CLEARED)
      expect(option('d')).toBeTruthy()
      expect(listbox().hasAttribute('aria-activedescendant')).toBe(false)
      expect(noneSelected()).toBe(true)
      key('Enter')
      await flush()
      expect(activeTab().loc.path).toBe(LDIR)
      key(' ')
      expect(screen.queryByRole('dialog')).toBeNull()
      key('F2')
      expect(screen.queryByRole('textbox', { name: en['menu.newName'] })).toBeNull()
    }
    h.handlers['local:deleteBatch'] = () => ({ success: false, error: 'permission denied' })
    await failThenCheck()
    toastError.mockClear()
    h.handlers['local:deleteBatch'] = () => Promise.reject(new Error('channel not allowed'))
    await failThenCheck()
  })

  it.each(['grid', 'list'] as const)(
    'clears the selection, focus and anchor on a plain click on empty space (%s)',
    async (view) => {
      // covers: Test-857
      await remoteFiles(FIVE, {
        view,
        sel: [p('b.txt'), p('c.txt')],
        anchor: p('b.txt'),
        focus: p('c.txt')
      })
      expect(activeId()).toBe(optId(p('c.txt')))
      fireEvent.mouseDown(option('e.txt').parentElement as HTMLElement)
      fireEvent.mouseUp(window)
      expect(selectionOf()).toEqual(CLEARED)
      expect(listbox().hasAttribute('aria-activedescendant')).toBe(false)
      expect(noneSelected()).toBe(true)
    }
  )

  it('focuses the last marquee item, keeps the selection on modified empty presses and clears on a plain one', async () => {
    // covers: Test-858
    await remoteFiles(FIVE, { view: 'list' })
    const box = option('a.txt').parentElement as HTMLElement
    fireEvent.mouseDown(box, { clientX: 40, clientY: FIVE.length * ROW + 10 })
    fireEvent.mouseMove(window, { clientX: 60, clientY: ROW + 10 })
    expect(selectedNames()).toEqual(['b.txt', 'c.txt', 'd.txt', 'e.txt'])
    expect(activeTab().focus).toBe(p('e.txt'))
    expect(activeId()).toBe(optId(p('e.txt')))
    fireEvent.mouseUp(window)

    const before = selectionOf()
    for (const mod of [{ ctrlKey: true }, { shiftKey: true }]) {
      pressEmpty(mod)
      expect(selectionOf()).toEqual(before)
    }
    pressEmpty()
    expect(selectionOf()).toEqual(CLEARED)
  })

  it.each(['grid', 'list'] as const)(
    'lets the %s marquee box fill the scroller so a drag can start below the last item',
    async (view) => {
      // covers: Test-1329
      await remoteFiles(['a.txt', 'b.txt'], { view })
      const box = option('a.txt').parentElement as HTMLElement
      const wrapper = box.parentElement as HTMLElement
      expect(box.style.minHeight).toBe('100%')
      expect(wrapper.parentElement?.id).toBe(`explorer-list-${activeTab().id}`)
      expect(wrapper.classList.contains('h-full')).toBe(true)
    }
  )

  it('moves the selection with Ctrl or Cmd plus an arrow and adds a range with Ctrl+Shift', async () => {
    // covers: Test-859
    const names = Array.from({ length: 14 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`)
    await remoteFiles(names)
    key('ArrowRight')
    expect(selectedNames()).toEqual(['f00.txt'])
    key('ArrowRight', { ctrlKey: true })
    expect(selectedNames()).toEqual(['f01.txt'])
    expect(activeId()).toBe(optId(p('f01.txt')))
    key('ArrowLeft', { metaKey: true })
    expect(selectedNames()).toEqual(['f00.txt'])
    expect(activeId()).toBe(optId(p('f00.txt')))
    key('ArrowRight', { metaKey: true })
    expect(selectedNames()).toEqual(['f01.txt'])
    key('ArrowRight', { ctrlKey: true, shiftKey: true })
    expect(selectedNames()).toEqual(['f01.txt', 'f02.txt'])
  })

  it('clears selection, focus and anchor on Esc before it clears the find query', async () => {
    // covers: Test-860
    await remoteFiles(['f0.txt', 'f1.txt', 'f2.txt'])
    fireEvent.click(option('f0.txt'))
    fireEvent.click(option('f1.txt'), { ctrlKey: true })
    act(() => useTabsStore.getState().patchTab(activeTab().id, { query: 'f' }))
    key('Escape')
    expect(selectionOf()).toEqual(CLEARED)
    expect(listbox().hasAttribute('aria-activedescendant')).toBe(false)
    expect(activeTab().query).toBe('f')
    key('Escape')
    expect(activeTab().query).toBe('')
    expect(fireEvent.keyDown(listbox(), { key: 'Escape' })).toBe(true)
  })

  it('does not fall back to the first item when nothing is selected', async () => {
    // covers: Test-861
    h = setupExplorer({
      remote: { [DIR]: [ftp('sub', { dir: true }), ftp('a.jpg')], [`${DIR}/sub`]: [] }
    })
    await renderExplorer(remoteLoc(DIR))
    useSettingsStore.setState({ confirmBeforeDelete: true })
    listbox().focus()
    expect(listbox().hasAttribute('aria-activedescendant')).toBe(false)
    for (const o of screen.getAllByRole('option')) {
      expect(o.getAttribute('aria-selected')).toBe('false')
      for (const el of [o, ...o.querySelectorAll('*')])
        expect(el.getAttribute('class') ?? '').not.toMatch(
          /(^|\s)(ring-|outline|bg-\[var\(--acw\)\])/
        )
    }
    key('Enter')
    await flush()
    expect(activeTab().loc.path).toBe(DIR)
    key(' ')
    expect(screen.queryByRole('dialog')).toBeNull()
    key('F2')
    expect(screen.queryByRole('textbox', { name: en['menu.newName'] })).toBeNull()
    key('Delete')
    await flush()
    expect(useConfirmStore.getState().request).toBeNull()
    expect(invokeCalls(h.invoke, 'ftp:deleteBatch')).toHaveLength(0)
    key('S', { shiftKey: true })
    expect(useShelfStore.getState().items).toEqual([])
    key('ContextMenu')
    expect(menu()).not.toBeNull()
    expect(screen.queryByRole('menuitem', { name: en['menu.open'] })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: en['menu.rename'] })).toBeNull()
    expect(
      screen.getByRole('menuitem', { name: new RegExp(en['explorer.newFolder']) })
    ).toBeTruthy()
  })

  it('points aria-activedescendant at the selected item that keys act on', async () => {
    // covers: Test-862
    await remoteFiles(FIVE, { view: 'list' })
    // ① 클릭
    fireEvent.click(option('b.txt'))
    expect(activeId()).toBe(optId(p('b.txt')))
    expect(document.getElementById(activeId() as string)?.getAttribute('aria-selected')).toBe(
      'true'
    )
    // ② Shift 범위의 끝 항목(focus)
    key('ArrowDown', { shiftKey: true })
    expect(activeId()).toBe(optId(p('c.txt')))
    // ③ Ctrl+A는 focus를 그대로 둔다. focus가 없었다면 속성이 없다.
    key('a', { ctrlKey: true })
    expect(activeId()).toBe(optId(p('c.txt')))
    key('Escape')
    key('a', { ctrlKey: true })
    expect(selectedNames()).toEqual(FIVE)
    expect(listbox().hasAttribute('aria-activedescendant')).toBe(false)
    // ④ 찾기로 숨으면 속성이 없다(items[0]로 대체하지 않는다).
    fireEvent.click(option('b.txt'))
    act(() => useTabsStore.getState().patchTab(activeTab().id, { query: 'a' }))
    expect(listbox().hasAttribute('aria-activedescendant')).toBe(false)

    // ⑥ 숨은 focus + 모두 선택(Ctrl+A, 빈 곳 메뉴의 "모두 선택")
    const hiddenThenSelectAll = async (selectAll: () => void): Promise<void> => {
      act(() => useTabsStore.getState().patchTab(activeTab().id, { query: '' }))
      fireEvent.click(option('b.txt'))
      expect(activeTab().focus).toBe(p('b.txt'))
      act(() => useTabsStore.getState().patchTab(activeTab().id, { query: 'p' }))
      selectAll()
      const visible = screen.getAllByRole('option')
      expect(activeTab().sel).toEqual(visible.map((o) => o.getAttribute('data-path')))
      expect(activeTab().focus).toBeNull()
      expect(listbox().hasAttribute('aria-activedescendant')).toBe(false)
      expect(visible.every((o) => o.getAttribute('aria-selected') === 'true')).toBe(true)
      key('Enter')
      await flush()
      expect(screen.queryByRole('dialog')).toBeNull()
    }
    cleanup()
    h.restore()
    await remoteFiles(['pa.jpg', 'b.txt', 'pc.jpg'], { view: 'list' })
    await hiddenThenSelectAll(() => key('a', { ctrlKey: true }))
    await hiddenThenSelectAll(() => {
      key('ContextMenu')
      fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(en['menu.selectAll']) }))
    })

    // ⑤ 라이트박스에서 넘긴 항목(Test-793 흐름)
    cleanup()
    h.restore()
    h = setupExplorer({ remote: { [DIR]: [ftp('a.jpg'), ftp('b.jpg')] } })
    await renderExplorer(remoteLoc(DIR))
    h.handlers['ftp:downloadPreview'] = () => ({
      success: true,
      data: 'data:image/png;base64,AA=='
    })
    key('Home')
    key(' ')
    await flush()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' })
    await flush()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(activeId()).toBe(optId(p('b.jpg')))
    expect(document.getElementById(activeId() as string)?.getAttribute('aria-selected')).toBe(
      'true'
    )
  })

  it.each(['grid', 'list'] as const)(
    'draws only idle, hover and focus item states (%s)',
    async (view) => {
      // covers: Test-863
      const four = ['a.txt', 'b.txt', 'c.txt', 'd.txt']
      await remoteFiles(four, {
        view,
        sel: [p('b.txt'), p('c.txt')],
        anchor: p('b.txt'),
        focus: p('c.txt')
      })
      listbox().focus()
      const cls = (n: string): string => option(n).className
      for (const n of ['a.txt', 'd.txt']) {
        expect(cls(n)).not.toContain('bg-[var(--acw)]')
        expect(cls(n)).toContain('hover:bg-[var(--hv)]')
      }
      for (const n of ['b.txt', 'c.txt']) {
        expect(cls(n)).toContain('bg-[var(--acw)]')
        expect(cls(n)).not.toContain('hover:bg-')
      }
      expect(cls('b.txt')).toBe(cls('c.txt'))
      const before = four.map(cls)
      key('l', { ctrlKey: true })
      fireEvent.blur(listbox())
      screen.getByRole('textbox', { name: en['path.edit'] }).focus()
      expect(four.map(cls)).toEqual(before)
      for (const o of screen.getAllByRole('option')) {
        expect(o.outerHTML).not.toContain('--selin')
        expect(o.outerHTML).not.toContain('ring-focus')
        expect(o.className).not.toMatch(/(^|\s)-?outline-/)
      }
      if (view === 'grid')
        for (const n of ['b.txt', 'c.txt']) {
          const box = option(n).firstElementChild as HTMLElement
          expect(box.classList.contains('ring-2')).toBe(true)
          expect(box.classList.contains('ring-[var(--ac)]')).toBe(true)
        }
    }
  )

  it('toggles the focused item with Ctrl+Space and moves the focus to what remains', async () => {
    // covers: Test-865
    await remoteFiles(['a.txt', 'b.txt', 'c.txt', 'd.txt'])
    fireEvent.click(option('b.txt'))
    key(' ', { ctrlKey: true })
    expect(activeTab().sel).toEqual([])
    expect(activeTab().focus).toBeNull()
    fireEvent.click(option('b.txt'))
    fireEvent.click(option('c.txt'), { ctrlKey: true })
    expect(activeTab().focus).toBe(p('c.txt'))
    key(' ', { ctrlKey: true })
    expect(selectedNames()).toEqual(['b.txt'])
    expect(activeTab().focus).toBe(p('b.txt'))
    expect(activeId()).toBe(optId(p('b.txt')))
    key('Escape')
    key(' ', { ctrlKey: true })
    expect(selectionOf()).toEqual(CLEARED)
  })

  it('applies the same rule to the tile check circle', async () => {
    // covers: Test-866
    await remoteFiles(['a.txt', 'b.txt', 'c.txt'])
    fireEvent.click(option('a.txt'))
    const check = option('b.txt').querySelector('button') as HTMLElement
    fireEvent.click(check)
    expect(selectedNames()).toEqual(['a.txt', 'b.txt'])
    expect(activeTab().focus).toBe(p('b.txt'))
    fireEvent.click(check)
    expect(selectedNames()).toEqual(['a.txt'])
    expect(activeTab().focus).toBe(p('a.txt'))
  })

  it('starts keyboard moves afresh after the selection is cleared', async () => {
    // covers: Test-867
    await remoteFiles(FIVE)
    const twoThenClear = (): void => {
      fireEvent.click(option('c.txt'))
      fireEvent.click(option('d.txt'), { ctrlKey: true })
      pressEmpty()
      expect(selectionOf()).toEqual(CLEARED)
    }
    twoThenClear()
    key('ArrowDown')
    expect(selectedNames()).toEqual(['a.txt'])
    twoThenClear()
    key('End')
    expect(selectedNames()).toEqual(['e.txt'])
    twoThenClear()
    key('ArrowDown', { shiftKey: true })
    expect(selectedNames()).toEqual(['a.txt'])
    twoThenClear()
    fireEvent.click(option('d.txt'), { shiftKey: true })
    expect(selectedNames()).toEqual(['d.txt'])
  })
})

describe('Explorer — file type filter', () => {
  const FDIR = '/c'
  const shown = (): string[] =>
    screen
      .getAllByRole('option')
      .map((o) => (o.getAttribute('data-path') ?? '').split('/').pop() ?? '')
  const filterButton = (): HTMLElement => screen.getByRole('button', { name: en['filter.button'] })
  const openMenu = (): HTMLElement => {
    fireEvent.click(filterButton())
    return screen.getByRole('dialog')
  }
  const pick = (name: string | RegExp): void => {
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('checkbox', { name }))
  }
  const closeMenu = (): void => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  }
  const setup = async (patch = {}): Promise<void> => {
    h = setupExplorer({
      remote: {
        [FDIR]: [
          ftp('a.jpg'),
          ftp('a.PNG'),
          ftp('b.cr3'),
          ftp('c.mp4'),
          ftp('d.txt'),
          ftp('README'),
          ftp('.hidden.jpg'),
          ftp('sub', { dir: true })
        ],
        '/d': [ftp('x.png'), ftp('y.txt')]
      }
    })
    await renderExplorer(remoteLoc(FDIR), patch)
  }

  it('filters by categories and extensions (OR), ANDs with find, and survives navigation per tab', async () => {
    // covers: Test-945
    await setup()
    expect(shown()).toEqual(['sub', 'a.jpg', 'a.PNG', 'b.cr3', 'c.mp4', 'd.txt', 'README'])

    openMenu()
    pick(/Images/)
    expect(shown()).toEqual(['sub', 'a.jpg', 'a.PNG'])
    pick(/RAW/)
    pick(/Videos/)
    // 이미지+RAW+비디오는 옛 "사진만"과 같은 항목이다.
    expect(shown()).toEqual(['sub', 'a.jpg', 'a.PNG', 'b.cr3', 'c.mp4'])
    pick(/RAW/)
    pick(/Videos/)

    // 카테고리(이미지) + 확장자(.txt)는 합집합이다.
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('checkbox', { name: '.txt (1)' }))
    expect(shown()).toEqual(['sub', 'a.jpg', 'a.PNG', 'd.txt'])
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('checkbox', { name: '.txt (1)' }))

    // 찾기는 AND이고, 드롭다운의 개수는 찾기를 반영하지 않는다(E19).
    act(() => useTabsStore.getState().patchTab(activeTab().id, { query: 'a' }))
    expect(shown()).toEqual(['a.jpg', 'a.PNG'])
    expect(
      within(screen.getByRole('dialog'))
        .getByRole('checkbox', { name: /Images/ })
        .closest('label')?.textContent
    ).toBe('Images (2)')
    // 찾기가 이미지를 모두 떨궈도 개수는 폴더 전체 기준이다(find로 좁힌 목록이 넘어가면 0이 된다).
    act(() => useTabsStore.getState().patchTab(activeTab().id, { query: 'b' }))
    expect(shown()).toEqual(['sub'])
    expect(
      within(screen.getByRole('dialog'))
        .getByRole('checkbox', { name: /Images/ })
        .closest('label')?.textContent
    ).toBe('Images (2)')
    closeMenu()

    // 폴더를 옮기면 찾기는 지워지고 필터는 남는다. 다른 탭은 영향이 없다.
    const second = useTabsStore.getState().openTab(remoteLoc('/d'), false)
    act(() => useTabsStore.getState().navigate(remoteLoc('/d')))
    await flush()
    expect(activeTab().query).toBe('')
    expect(activeTab().filter.categories).toEqual(['image'])
    expect(shown()).toEqual(['x.png'])
    expect(useTabsStore.getState().tabs.find((t) => t.id === second)!.filter).toEqual(EMPTY_FILTER)

    // 선택은 보이는 항목만 센다.
    act(() => useTabsStore.getState().navigate(remoteLoc(FDIR)))
    await flush()
    act(() => useTabsStore.getState().patchTab(activeTab().id, { query: '' }))
    key('a', { ctrlKey: true })
    expect(selectedNames()).toEqual(['a.PNG', 'a.jpg', 'sub'])
  })

  it('applies edits made in settings straight away', async () => {
    // covers: Test-951
    await setup()
    const store = useFileCategoryStore.getState()
    store.removeExtension('image', 'png')
    const id = store.addCustom('Docs')!
    store.addExtension(id, 'txt')

    const dialog = openMenu()
    expect(
      within(dialog)
        .getByRole('checkbox', { name: /Images/ })
        .closest('label')?.textContent
    ).toBe('Images (1)')
    expect(
      within(dialog).getByRole('checkbox', { name: /Docs/ }).closest('label')?.textContent
    ).toBe('Docs (1)')
    pick(/Images/)
    expect(shown()).toEqual(['sub', 'a.jpg'])
    pick(/Docs/)
    expect(shown()).toEqual(['sub', 'a.jpg', 'd.txt'])
    closeMenu()

    // 이미지 카테고리를 숨기면 드롭다운에서 사라지고 걸려 있던 이미지 체크는 무시된다(E15).
    act(() => useFileCategoryStore.getState().setHidden('image', true))
    expect(shown()).toEqual(['sub', 'd.txt'])
    openMenu()
    expect(screen.queryByRole('checkbox', { name: /Images/ })).toBeNull()
    expect(activeTab().filter.categories).toEqual(['image', id])
    closeMenu()
    act(() => useFileCategoryStore.getState().setHidden('image', false))
    expect(shown()).toEqual(['sub', 'a.jpg', 'd.txt'])
  })

  it('does not act on a selected item the filter hides', async () => {
    // covers: Test-954
    h = setupExplorer({ remote: { [FDIR]: [ftp('a.jpg'), ftp('b.txt')] } })
    await renderExplorer(remoteLoc(FDIR))
    const bPath = `${FDIR}/b.txt`
    const deletes = (): unknown[][] => invokeCalls(h.invoke, 'ftp:deleteBatch')
    const hook = renderHook(() => useTabEntries(useActiveTab()))

    // (1) 양성 대조: 필터가 없으면 b.txt가 삭제 대상에 든다.
    act(() => useTabsStore.getState().patchTab(activeTab().id, { sel: [bPath] }))
    key('Delete')
    await flush()
    expect(JSON.stringify(deletes())).toContain(bPath)
    const callsBefore = deletes().length

    // (2) 이미지 필터가 b.txt를 가리면 삭제 대상이 아니다.
    act(() =>
      useTabsStore.getState().patchTab(activeTab().id, {
        sel: [bPath],
        filter: { ...EMPTY_FILTER, categories: ['image'] }
      })
    )
    expect(hook.result.current.selected).toEqual([])
    key('Delete')
    await flush()
    expect(deletes()).toHaveLength(callsBefore)

    // (3) 확인창을 켜도 숨은 선택 때문에 뜨지 않는다.
    useSettingsStore.setState({ confirmBeforeDelete: true })
    key('Delete')
    await flush()
    expect(useConfirmStore.getState().request).toBeNull()

    // (4) 필터를 풀면 선택이 되살아난다.
    act(() => useTabsStore.getState().patchTab(activeTab().id, { filter: EMPTY_FILTER }))
    expect(hook.result.current.selected.map((e) => e.name)).toEqual(['b.txt'])
  })
})

describe('Explorer — remote location change cancels this panel’s pending work', () => {
  it('cancels thumbnails and folder previews before the new batch and clears only that server’s previews', async () => {
    // covers: Test-1024
    h = setupExplorer({
      remote: { '/': [ftp('dir', { dir: true })], '/sub': [ftp('new.jpg', { size: 1000 })] }
    })
    await renderExplorer(remoteLoc('/'))
    const other = connKey('other.example', 21, 'kim')
    const resolved = { status: 'resolved', preview: null } as const
    useGalleryStore.setState({
      remoteFolderPreviews: {
        [`${server()}|/photos`]: resolved,
        [`${other}|/photos`]: resolved
      }
    })
    h.invoke.mockClear()

    act(() => useTabsStore.getState().navigate(remoteLoc('/sub')))
    await flush()

    const calls = h.invoke.mock.calls
    const cancelThumbs = calls.findIndex((c) => c[0] === 'thumbnail:cancelAll')
    const cancelGallery = calls.findIndex((c) => c[0] === 'gallery:cancelAll')
    const firstBatch = calls.findIndex((c) => c[0] === 'thumbnail:requestBatch')
    expect(cancelThumbs).toBeGreaterThanOrEqual(0)
    expect(cancelGallery).toBeGreaterThanOrEqual(0)
    expect(firstBatch).toBeGreaterThan(Math.max(cancelThumbs, cancelGallery))
    expect(calls[cancelThumbs]).toEqual(['thumbnail:cancelAll', null, MAIN_VIEWER])
    expect(calls[cancelGallery]).toEqual(['gallery:cancelAll', null, MAIN_VIEWER])
    expect(Object.keys(useGalleryStore.getState().remoteFolderPreviews)).toEqual([
      `${other}|/photos`
    ])
  })
})

describe('Explorer — drop hint pill', () => {
  it('lifts the transfer hint pill above the shelf strip while a drag is over the pane', async () => {
    // covers: Test-1292
    h = setupExplorer({ remote: { [DIR]: [ftp('a.jpg')] }, local: { [LDIR]: [] } })
    await renderExplorer(remoteLoc(DIR))
    act(() =>
      useDnd.setState({
        items: [fromFtpEntry(ftp('x.jpg'), '/elsewhere', server())],
        over: null,
        thumbs: []
      })
    )
    fireEvent.dragOver(listbox(), {
      dataTransfer: { dropEffect: '', types: [], files: [] }
    })
    // 담기 띠는 `fixed bottom-8 h-14`(상태 막대 위 3.5rem)다. 알약은 그 위에 놓인다.
    const pill = screen.getByText('Move 1 to photos').parentElement
    expect(pill?.className).toContain('bottom-20')
    expect(pill?.className).not.toContain('bottom-6')
  })
})
