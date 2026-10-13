/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

    expect(screen.getAllByRole('option')).toHaveLength(3)

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
