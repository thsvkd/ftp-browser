/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'react-dom'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { toast } from 'sonner'
import { en } from '@renderer/i18n/locales/en'
import { useShelfStore } from '@renderer/stores/useShelfStore'
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

describe('PathBar — find, photos, sort and view', () => {
  it('focuses find with Ctrl+F and keeps photos only, sort and view on the active tab', async () => {
    // covers: Test-828
    fireEvent.keyDown(listbox(), { key: 'f', ctrlKey: true })
    const find = screen.getByRole('textbox', { name: en['filter.find'] })
    expect(document.activeElement).toBe(find)
    fireEvent.change(find, { target: { value: 'not' } })
    expect(activeTab().query).toBe('not')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: en['filter.clear'] }))

    const photos = screen.getByRole('button', { name: en['filter.photosOnly'] })
    fireEvent.click(photos)
    expect(activeTab().photosOnly).toBe(true)
    expect(photos.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getAllByRole('option')).toHaveLength(2)

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
    expect(invokeCalls(h.invoke, 'ftp:rename')).toEqual([['/a/b/c/x.jpg', '/x.jpg']])
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
