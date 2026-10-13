/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'react-dom'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { toast } from 'sonner'
import { en } from '@renderer/i18n/locales/en'
import { useFileCategoryStore } from '@renderer/stores/useFileCategoryStore'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { fromFtpEntry } from '@renderer/lib/explorerEntry'
import { invokeCalls } from '@renderer/test/rendererTestUtils'
import { useDnd } from './dnd'
import {
  activeTab,
  flush,
  ftp,
  listbox,
  remoteLoc,
  renderExplorer,
  server,
  setConnection,
  setupExplorer,
  type ExplorerHarness
} from './explorerTestHarness'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() })
}))

let h: ExplorerHarness
beforeEach(async () => {
  vi.clearAllMocks()
  h = setupExplorer({
    remote: {
      '/a/b/c': [ftp('x.jpg'), ftp('notes.txt'), ftp('y.png')],
      '/a': [],
      '/a/b': [],
      '/z': [ftp('z.txt')],
      '/': [ftp('r.txt')]
    }
  })
  await renderExplorer(remoteLoc('/a/b/c'))
})
afterEach(() => {
  cleanup()
  h.restore()
})

const pathNav = (): HTMLElement => screen.getByRole('navigation', { name: en['path.label'] })
const textbox = (): HTMLElement => screen.getByRole('textbox', { name: en['path.edit'] })

/** 막대 폭을 정하고(측정 줄은 하네스가 40px로 둔다) 그 위치로 다시 그린다. */
async function renderAt(width: number, path = '/a/b/c'): Promise<void> {
  cleanup()
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: width })
  await renderExplorer(remoteLoc(path))
}
const moreButton = (): HTMLElement => screen.getByRole('button', { name: en['path.moreTools'] })
const moreMenu = (): HTMLElement => screen.getByRole('menu', { name: en['path.moreTools'] })
const moreItem = (name: string): HTMLElement =>
  within(moreMenu()).getByRole('menuitem', { name: new RegExp(`^${name}`) })
/** ⋯ 메뉴를 마우스로 열고 그 항목을 누른다. */
function pickMore(name: string): void {
  fireEvent.click(moreButton(), { detail: 1 })
  fireEvent.click(moreItem(name))
}
const FOLDED = [
  en['explorer.forward'],
  en['toolbar.refresh'],
  en['filter.button'],
  en['sort.label'],
  en['view.grid'],
  en['view.list'],
  en['explorer.newFolder'],
  en['explorer.details']
]

describe('PathBar — crumbs and typing a path', () => {
  it('navigates by crumb, edits by empty-space click or Ctrl+L, and collapses the middle when narrow', async () => {
    // covers: Test-826
    // 스텁된 레이아웃에서는 조각마다 1200px라 마지막 조각만 남고 나머지는 "…" 뒤로 접힌다.
    const more = within(pathNav()).getByRole('button', { name: en['path.hidden'] })
    expect(within(pathNav()).getByRole('button', { name: 'c' })).toBeTruthy()
    expect(within(pathNav()).queryByRole('button', { name: 'a' })).toBeNull()
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem', { name: 'a' }))
    await flush()
    expect(activeTab().loc.path).toBe('/a')

    // 조각을 누르면 그리로 간다(루트 배지 포함).
    fireEvent.click(screen.getByRole('button', { name: /root$/ }))
    await flush()
    expect(activeTab().loc.path).toBe('/')

    // 빈 곳 클릭 → 입력, Esc 취소
    fireEvent.click(pathNav())
    expect(textbox()).toBeTruthy()
    fireEvent.keyDown(textbox(), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: en['path.edit'] })).toBeNull()

    // Ctrl+L → 입력, Enter 이동
    fireEvent.keyDown(listbox(), { key: 'l', ctrlKey: true })
    fireEvent.change(textbox(), { target: { value: '/z/' } })
    fireEvent.keyDown(textbox(), { key: 'Enter' })
    await flush()
    expect(activeTab().loc.path).toBe('/z')

    // 없는 경로는 토스트로 알리고 그대로 둔다.
    fireEvent.keyDown(listbox(), { key: 'l', ctrlKey: true })
    fireEvent.change(textbox(), { target: { value: '/nope' } })
    fireEvent.keyDown(textbox(), { key: 'Enter' })
    await flush()
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to open "/nope"', {
      description: 'No such directory'
    })
    expect(activeTab().loc.path).toBe('/z')
  })
})

describe('PathBar — find, type filter, sort and view', () => {
  it('focuses find with Ctrl+F and keeps the file type filter, sort and view on the active tab', async () => {
    // covers: Test-828
    fireEvent.keyDown(listbox(), { key: 'f', ctrlKey: true })
    const find = screen.getByRole('textbox', { name: en['filter.find'] })
    expect(document.activeElement).toBe(find)
    fireEvent.change(find, { target: { value: 'not' } })
    expect(activeTab().query).toBe('not')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: en['filter.clear'] }))

    expect(screen.getAllByRole('option')).toHaveLength(3)

    const filter = screen.getByRole('button', { name: en['filter.button'] })
    fireEvent.click(filter)
    fireEvent.click(screen.getByRole('checkbox', { name: /Images/ }))
    expect(activeTab().filter.categories).toEqual(['image'])
    expect(filter.getAttribute('data-active')).toBe('true')
    expect(screen.getAllByRole('option')).toHaveLength(2)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: en['sort.label'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: en['file.size'] }))
    expect(activeTab().sort.key).toBe('size')
    fireEvent.click(screen.getByRole('button', { name: en['sort.label'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: en['sort.descending'] }))
    expect(activeTab().sort.dir).toBe('desc')
    fireEvent.click(screen.getByRole('button', { name: en['sort.label'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: en['sort.foldersFirst'] }))
    expect(activeTab().sort.foldersFirst).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: en['view.list'] }))
    expect(activeTab().view).toBe('list')
    expect(screen.getByRole('button', { name: en['view.list'] }).getAttribute('aria-pressed')).toBe(
      'true'
    )

    fireEvent.click(screen.getByRole('button', { name: en['explorer.details'] }))
    expect(useShelfStore.getState().railTab).toBe('info')

    // A narrow bar shows only the magnifier: Ctrl+F opens the field and focuses it as well.
    cleanup()
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 })
    await renderExplorer(remoteLoc('/z'))
    expect(screen.queryByRole('textbox', { name: en['filter.find'] })).toBeNull()
    fireEvent.keyDown(listbox(), { key: 'f', ctrlKey: true })
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: en['filter.find'] }))
  })
})

describe('PathBar — file type filter button', () => {
  const button = (): HTMLElement => screen.getByRole('button', { name: en['filter.button'] })

  it('shows the active state, a count badge and the hidden count, and drops the photos-only chip', async () => {
    // covers: Test-944
    expect(button().getAttribute('data-active')).toBeNull()
    expect(button().textContent).toBe('Filter')
    expect(button().title).toBe(en['filter.buttonTooltip'])
    expect(screen.queryByRole('button', { name: /Photos and videos only/ })).toBeNull()

    act(() =>
      useTabsStore.getState().patchTab(activeTab().id, {
        filter: { categories: ['image', 'video'], extensions: ['log'], noExtension: false }
      })
    )
    expect(button().getAttribute('data-active')).toBe('true')
    expect(button().textContent).toBe('Filter3')
    // notes.txt는 이미지·비디오·.log 어디에도 없어 하나가 가려진다.
    expect(button().title).toBe('Filter: Images, Videos, .log · 1 hidden')

    // 해석되지 않는(숨긴) 카테고리 id는 배지에 세지 않는다.
    act(() => useFileCategoryStore.getState().setHidden('video', true))
    expect(button().textContent).toBe('Filter2')
    expect(button().title).toBe('Filter: Images, .log · 1 hidden')

    // 좁은 막대에서는 라벨이 숨고 배지는 남는다.
    cleanup()
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 })
    await renderExplorer(remoteLoc('/a/b/c'), {
      filter: { categories: ['image'], extensions: ['log'], noExtension: false }
    })
    expect(button().textContent).toBe('2')
    expect(button().getAttribute('aria-label')).toBe(en['filter.button'])
  })
})

describe('PathBar — dropping on a crumb', () => {
  it('sends dragged items to the crumb’s folder and labels the crumb with the verb', async () => {
    // covers: Test-827
    const dt = (): Record<string, unknown> => ({ types: [], files: [], dropEffect: '' })
    act(() =>
      useDnd.setState({
        items: [fromFtpEntry(ftp('x.jpg'), '/a/b/c', server())],
        over: null,
        thumbs: []
      })
    )
    const root = within(pathNav()).getByRole('button', { name: /root$/ })
    const over = dt()
    fireEvent.dragOver(root, { dataTransfer: over })
    expect(over.dropEffect).toBe('move')
    expect(within(root).getByText('Move 1')).toBeTruthy()
    // 지금 폴더의 조각은 놓기 대상이 아니다.
    const current = within(pathNav()).getByRole('button', { name: 'c' })
    fireEvent.dragOver(current, { dataTransfer: dt() })
    expect(within(current).queryByText('Move 1')).toBeNull()

    fireEvent.drop(root, { dataTransfer: dt() })
    await flush()
    expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([[server(), '/a/b/c/x.jpg', '/x.jpg']])
  })
})

describe('PathBar — one line with a ⋯ menu', () => {
  it('keeps the bar on one line and folds the tools that do not fit into ⋯ in bar order', async () => {
    // covers: Test-1165
    // 스텁 기본 폭 1200: 접히는 도구가 없다.
    expect(screen.queryByRole('button', { name: en['path.moreTools'] })).toBeNull()
    // 넓은 막대의 찾기는 칸이다.
    expect(screen.getByRole('textbox', { name: en['filter.find'] })).toBeTruthy()
    for (const name of FOLDED) expect(screen.getByRole('button', { name })).toBeTruthy()

    await renderAt(400)
    const bar = document.querySelector<HTMLElement>('.path-bar')
    const tools = document.querySelector<HTMLElement>('[data-path-tools]')
    expect(bar?.classList.contains('flex-wrap')).toBe(false)
    expect(tools?.classList.contains('flex-wrap')).toBe(false)
    expect(screen.getByRole('button', { name: en['filter.find'] })).toBeTruthy()
    for (const name of FOLDED) expect(screen.queryByRole('button', { name })).toBeNull()

    expect(moreButton().getAttribute('aria-haspopup')).toBe('menu')
    expect(moreButton().getAttribute('aria-expanded')).not.toBe('true')
    fireEvent.click(moreButton(), { detail: 1 })
    const all = within(moreMenu()).getAllByRole('menuitem')
    expect(all).toHaveLength(FOLDED.length)
    expect(FOLDED.map((name) => all.indexOf(moreItem(name)))).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(moreItem(en['explorer.forward'])).toHaveProperty('disabled', true)
    expect(moreButton().getAttribute('aria-expanded')).toBe('true')
    expect(moreItem(en['explorer.forward']).getAttribute('aria-keyshortcuts')).toBe('Alt+→')
    expect(moreItem(en['toolbar.refresh']).getAttribute('aria-keyshortcuts')).toBe('F5')
    expect(moreItem(en['explorer.newFolder']).getAttribute('aria-keyshortcuts')).toBe(
      'Ctrl+Shift+N'
    )
    expect(moreItem(en['explorer.details']).getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+P')
  })

  it('runs refresh, sort, view, details, new folder and forward from the ⋯ menu', async () => {
    // covers: Test-1166
    await renderAt(300)
    const lists = (): number =>
      invokeCalls(h.invoke, 'ftp:list').filter((c) => c[1] === '/a/b/c').length
    const before = lists()
    pickMore(en['toolbar.refresh'])
    await flush()
    expect(lists()).toBe(before + 1)

    fireEvent.click(moreButton(), { detail: 1 })
    fireEvent.click(moreItem(en['sort.label']))
    fireEvent.click(
      within(screen.getAllByRole('menu')[1]).getByRole('menuitem', { name: en['file.size'] })
    )
    expect(activeTab().sort.key).toBe('size')

    pickMore(en['view.list'])
    expect(activeTab().view).toBe('list')
    fireEvent.click(moreButton(), { detail: 1 })
    expect(moreItem(en['view.list']).querySelector('.lucide-check')).toBeTruthy()
    expect(moreItem(en['view.grid']).querySelector('.lucide-check')).toBeNull()
    fireEvent.click(moreItem(en['explorer.details']))
    expect(useShelfStore.getState().railTab).toBe('info')

    pickMore(en['explorer.newFolder'])
    await flush()
    expect(invokeCalls(h.invoke, 'ftp:mkdir')).toEqual([[server(), '/a/b/c/New folder']])

    // 앞으로는 뒤로 간 뒤에만 켜진다.
    act(() => useTabsStore.getState().navigate(remoteLoc('/z'), { tabId: activeTab().id }))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: en['explorer.back'] }))
    await flush()
    expect(activeTab().loc.path).toBe('/a/b/c')
    fireEvent.click(moreButton(), { detail: 1 })
    expect(moreItem(en['explorer.forward'])).toHaveProperty('disabled', false)
    fireEvent.click(moreItem(en['explorer.forward']))
    await flush()
    expect(activeTab().loc.path).toBe('/z')

    // 연결이 끊긴(쓸 수 없는) 탭에서는 새 폴더가 비활성이다.
    act(() => setConnection(server(), 'disconnected'))
    await flush()
    fireEvent.click(moreButton(), { detail: 1 })
    expect(moreItem(en['explorer.newFolder'])).toHaveProperty('disabled', true)
  })

  it('marks ⋯ when the folded filter is on and opens the filter popover under it', async () => {
    // covers: Test-1167
    await renderAt(300)
    expect(moreButton().getAttribute('data-active')).toBeNull()
    act(() =>
      useTabsStore.getState().patchTab(activeTab().id, {
        filter: { categories: ['image'], extensions: [], noExtension: false }
      })
    )
    expect(moreButton().getAttribute('data-active')).toBe('true')
    fireEvent.click(moreButton(), { detail: 1 })
    expect(moreItem(en['filter.button']).getAttribute('aria-description')).toBe(
      'Filter: Images · 1 hidden'
    )
    fireEvent.click(moreItem(en['filter.button']))
    const dialog = screen.getByRole('dialog', { name: en['filter.menuLabel'] })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Videos/ }))
    expect(activeTab().filter.categories).toEqual(['image', 'video'])
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(moreButton())
  })

  it('opens a folded find field in the crumb slot with Ctrl+F or the ⋯ menu', async () => {
    // covers: Test-1168
    await renderAt(300)
    const find = (): HTMLElement | null =>
      screen.queryByRole('textbox', { name: en['filter.find'] })
    const nav = (): HTMLElement | null =>
      screen.queryByRole('navigation', { name: en['path.label'] })
    expect(find()).toBeNull()
    fireEvent.keyDown(listbox(), { key: 'f', ctrlKey: true })
    expect(find()).toBeTruthy()
    expect(document.activeElement).toBe(find())
    expect(nav()).toBeNull()
    fireEvent.change(find() as HTMLElement, { target: { value: 'x' } })
    expect(activeTab().query).toBe('x')
    act(() => listbox().focus())
    expect(find()).toBeTruthy()
    expect(nav()).toBeNull()
    act(() => (find() as HTMLElement).focus())
    fireEvent.keyDown(find() as HTMLElement, { key: 'Escape' })
    expect(activeTab().query).toBe('')
    expect(document.activeElement).toBe(listbox())
    expect(find()).toBeNull()
    expect(nav()).toBeTruthy()

    pickMore(en['filter.find'])
    expect(find()).toBeTruthy()
    expect(document.activeElement).toBe(find())
    expect(nav()).toBeNull()

    // 돋보기만 보이는 좁은 막대(Test-826과 같은 800): 칸이 막대의 찾기 자리에 열린다.
    await renderAt(800)
    expect(find()).toBeNull()
    fireEvent.keyDown(listbox(), { key: 'f', ctrlKey: true })
    expect(document.activeElement).toBe(find())
    expect(nav()).toBeTruthy()
  })

  it('keeps focus in the find field when opening it moves it from the tools to the crumb slot', async () => {
    // covers: Test-1200
    // R3 실측 도구 폭(§12 (a)). 돋보기 36은 막대 400에 들어가지만 열린 칸 150은 들어가지 않는다(Test-1164).
    const widths: Record<string, number> = {
      back: 32,
      up: 32,
      more: 32,
      forward: 32,
      reload: 28,
      filter: 38,
      sort: 49,
      view: 68,
      newFolder: 32,
      info: 32
    }
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement): number {
        if (!this.closest('[data-path-measure]')) return 1200
        const id = this.dataset.measure ?? ''
        if (id === 'search') return this.classList.contains('w-[150px]') ? 150 : 36
        return widths[id] ?? 0
      }
    })
    await renderAt(400)
    const find = (): HTMLElement | null =>
      screen.queryByRole('textbox', { name: en['filter.find'] })
    const nav = (): HTMLElement | null =>
      screen.queryByRole('navigation', { name: en['path.label'] })
    const tools = (): HTMLElement | null => document.querySelector('[data-path-tools]')
    const magnifier = (): HTMLElement => screen.getByRole('button', { name: en['filter.find'] })
    expect(tools()?.contains(magnifier())).toBe(true)
    expect(find()).toBeNull()

    fireEvent.keyDown(listbox(), { key: 'f', ctrlKey: true })
    expect(find()).toBeTruthy()
    expect(document.activeElement).toBe(find())
    expect(tools()?.contains(find())).toBe(false)
    expect(nav()).toBeNull()

    fireEvent.keyDown(find() as HTMLElement, { key: 'Escape' })
    expect(find()).toBeNull()
    expect(nav()).toBeTruthy()

    fireEvent.click(magnifier())
    expect(find()).toBeTruthy()
    expect(document.activeElement).toBe(find())
    expect(tools()?.contains(find())).toBe(false)
    expect(nav()).toBeNull()
  })

  it('does not reopen the filter popover by itself when the filter folds or unfolds', async () => {
    // covers: Test-1201
    const dialog = (): HTMLElement | null =>
      screen.queryByRole('dialog', { name: en['filter.menuLabel'] })
    // 포인터 없이 막대 폭만 바꾼다(키보드로 사이드바·분할 전환, OS 창 크기). 정렬 키를 바꿔 다시 재게 한다.
    const resizeTo = (width: number): void => {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        value: width
      })
      const { sort } = activeTab()
      act(() =>
        useTabsStore.getState().patchTab(activeTab().id, {
          sort: { ...sort, key: sort.key === 'name' ? 'size' : 'name' }
        })
      )
    }
    await renderAt(300)
    pickMore(en['filter.button'])
    expect(dialog()).toBeTruthy()
    resizeTo(1200)
    expect(screen.queryByRole('button', { name: en['path.moreTools'] })).toBeNull()
    expect(dialog()).toBeNull()
    resizeTo(300)
    expect(dialog()).toBeNull()

    // 거꾸로: 트리거로 열고 접혔다가 다시 펴져도 저절로 열리지 않는다.
    resizeTo(1200)
    fireEvent.click(screen.getByRole('button', { name: en['filter.button'] }))
    expect(dialog()).toBeTruthy()
    resizeTo(300)
    expect(dialog()).toBeNull()
    resizeTo(1200)
    expect(dialog()).toBeNull()
  })
})

describe('PathBar — menus opened from the keyboard', () => {
  it('focuses the first entry of the sort and hidden-crumbs menus opened by Enter or Space and returns focus on Esc', async () => {
    // covers: Test-1176
    act(() =>
      useTabsStore.getState().patchTab(activeTab().id, {
        sort: { ...activeTab().sort, key: 'size' }
      })
    )
    const sortButton = screen.getByRole('button', { name: en['sort.label'] })
    // Enter·Space로 누른 버튼의 click은 detail이 0이다.
    fireEvent.click(sortButton, { detail: 0 })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: en['file.name'] }))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Enter' })
    expect(activeTab().sort.key).toBe('name')

    const more = within(pathNav()).getByRole('button', { name: en['path.hidden'] })
    fireEvent.click(more, { detail: 0 })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'a' }))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Enter' })
    await flush()
    expect(activeTab().loc.path).toBe('/a')

    // 마우스 click(detail 1)은 지금처럼 메뉴 상자에 포커스
    fireEvent.click(screen.getByRole('button', { name: en['sort.label'] }), { detail: 1 })
    expect(document.activeElement).toBe(screen.getByRole('menu'))

    // Esc로 닫으면 연 버튼으로 돌아간다(X9).
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: en['sort.label'] }))

    act(() => useTabsStore.getState().navigate(remoteLoc('/a/b/c'), { tabId: activeTab().id }))
    await flush()
    const hiddenButton = within(pathNav()).getByRole('button', { name: en['path.hidden'] })
    fireEvent.click(hiddenButton, { detail: 0 })
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(hiddenButton)

    // 막대 폭 300의 ⋯: 비활성인 앞으로를 건너뛴 새로 고침에 포커스, Esc → ⋯
    await renderAt(300)
    fireEvent.click(moreButton(), { detail: 0 })
    expect(document.activeElement).toBe(moreItem(en['toolbar.refresh']))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(moreButton())
  })
})

// ---------- 메뉴를 연 click이 그 메뉴를 닫지 않는다(explorer-menu-and-focus M1) ----------

describe('PathBar — menus opened by a real click stay open', () => {
  // act 밖의 네이티브 click(§8 함정 1). 브라우저는 사용자 click의 리스너가 하나 끝날 때마다
  // 마이크로태스크 체크포인트를 돌아 React가 미뤄 둔 동기 렌더·effect가 전파 도중에 끝난다.
  // jsdom의 dispatchEvent에는 그 체크포인트가 없어서, React 루트(본문 안 컨테이너)와 document
  // 사이인 body의 버블 리스너에서 flushSync()로 같은 시점을 만든다. 호출처 코드는 그대로다(M2).
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  let saved: boolean | undefined
  const checkpoint = (): void => flushSync(() => undefined)
  beforeEach(() => {
    saved = env.IS_REACT_ACT_ENVIRONMENT
    env.IS_REACT_ACT_ENVIRONMENT = false
    document.body.addEventListener('click', checkpoint)
  })
  afterEach(() => {
    document.body.removeEventListener('click', checkpoint)
    env.IS_REACT_ACT_ENVIRONMENT = saved
  })
  const nativeClick = (el: Element): void => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('keeps the sort menu open after clicking the sort button', async () => {
    // covers: Test-848
    nativeClick(screen.getByRole('button', { name: en['sort.label'] }))
    await settle()
    const sort = screen.getByRole('menu', { name: en['sort.label'] })
    expect(within(sort).getByRole('menuitem', { name: en['file.size'] })).toBeTruthy()

    nativeClick(document.body)
    await settle()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('switches between the sort and hidden-crumbs menus with one click', async () => {
    // covers: Test-1179
    const sortButton = (): HTMLElement => screen.getByRole('button', { name: en['sort.label'] })
    const hiddenButton = (): HTMLElement =>
      within(pathNav()).getByRole('button', { name: en['path.hidden'] })
    const names = (): (string | null)[] =>
      screen.queryAllByRole('menu').map((m) => m.getAttribute('aria-label'))
    nativeClick(sortButton())
    await settle()
    expect(names()).toEqual([en['sort.label']])
    nativeClick(hiddenButton())
    await settle()
    expect(names()).toEqual([en['path.hidden']])
    nativeClick(sortButton())
    await settle()
    expect(names()).toEqual([en['sort.label']])

    // 막대 폭 400: "…" 메뉴를 연 채 ⋯
    await renderAt(400)
    nativeClick(hiddenButton())
    await settle()
    expect(names()).toEqual([en['path.hidden']])
    nativeClick(screen.getByRole('button', { name: en['path.moreTools'] }))
    await settle()
    expect(names()).toEqual([en['path.moreTools']])

    nativeClick(document.body)
    await settle()
    expect(names()).toEqual([])
  })

  it('keeps the hidden-crumbs menu open after clicking "…" and navigates from it', async () => {
    // covers: Test-849
    nativeClick(within(pathNav()).getByRole('button', { name: en['path.hidden'] }))
    await settle()
    const hidden = screen.getByRole('menu', { name: en['path.hidden'] })
    nativeClick(within(hidden).getByRole('menuitem', { name: 'a' }))
    await settle()
    expect(activeTab().loc.path).toBe('/a')
  })
})
