/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { en } from '@renderer/i18n/locales/en'
import { fromLocalEntry } from '@renderer/lib/explorerEntry'
import { useLayoutStore } from '@renderer/stores/useLayoutStore'
import { useListingStore } from '@renderer/stores/useListingStore'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import {
  activeTab,
  local,
  localLoc,
  setupExplorer,
  type ExplorerHarness
} from '@renderer/components/explorer/explorerTestHarness'
import { AppShell } from '@renderer/components/layout/AppShell'
import { InfoPanel } from './InfoPanel'

const DIR = 'C:\\work'
const ENTRIES = [
  local(DIR, 'albums', { dir: true }),
  local(DIR, 'a.jpg', { size: 1024 }),
  local(DIR, 'b.jpg', { size: 1024 }),
  local(DIR, 'notes.txt', { size: 2048 })
]

let h: ExplorerHarness
beforeEach(() => {
  vi.clearAllMocks()
  h = setupExplorer({ local: { [DIR]: ENTRIES } })
  h.handlers['local:getHome'] = () => ({ success: true, data: DIR })
  useListingStore.getState().put(localLoc(DIR), ENTRIES.map(fromLocalEntry))
  useTabsStore.getState().openTab(localLoc(DIR))
})
afterEach(() => {
  cleanup()
  h.restore()
})

const select = (...names: string[]): void =>
  act(() =>
    useTabsStore.getState().patchTab(activeTab().id, { sel: names.map((n) => `${DIR}\\${n}`) })
  )
const layout = (): ReturnType<typeof useLayoutStore.getState> => useLayoutStore.getState()

describe('InfoPanel', () => {
  it('summarizes the folder, one item or several items', () => {
    // covers: Test-835
    render(<InfoPanel />)
    // 선택 없음: 폴더 요약과 분류별 합계
    expect(screen.getByRole('heading', { name: 'work' })).toBeTruthy()
    expect(screen.getByText('1 folder')).toBeTruthy()
    expect(screen.getByText('3 files')).toBeTruthy()
    expect(screen.getByText('4 KB')).toBeTruthy()
    expect(screen.getByText(en['category.image']).parentElement?.textContent).toContain('2')
    expect(screen.getByText(en['category.doc'])).toBeTruthy()

    // 1개: 미리보기·이름·사실
    select('a.jpg')
    expect(screen.getByRole('heading', { name: 'a.jpg' })).toBeTruthy()
    expect(screen.getByRole('img', { name: en['thumbnail.loading'] })).toBeTruthy()
    expect(screen.getByText(en['properties.fullPath'])).toBeTruthy()
    expect(screen.getByText(`${DIR}\\a.jpg`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['menu.addToShelf'] }))
    expect(useShelfStore.getState().items.map((i) => i.entry.name)).toEqual(['a.jpg'])
    expect(screen.getByRole('button', { name: en['menu.removeFromShelf'] })).toBeTruthy()

    // 여러 개: 수·크기·분류별, 선반에 없는 것만 담는다
    select('a.jpg', 'notes.txt', 'albums')
    expect(screen.getByRole('heading', { name: '3 selected' })).toBeTruthy()
    expect(screen.getByText(/^3 KB/).textContent).toContain(en['send.folderContents'])
    expect(screen.getByText(en['category.doc'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 to shelf' }))
    expect(useShelfStore.getState().items.map((i) => i.entry.name)).toEqual([
      'a.jpg',
      'albums',
      'notes.txt'
    ])
  })

  it('toggles the info rail with the PathBar details button and Alt+Shift+P', async () => {
    // covers: Test-1255
    useLayoutStore.setState({ right: { width: 288, collapsed: false }, priority: null })
    render(<AppShell />)
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    expect(layout().right.collapsed).toBe(false)
    expect(screen.getByRole('region', { name: en['rail.info'] })).toBeTruthy()

    // 선반이 레일을 떠난 뒤에도 두 제어는 오른쪽 정보 패널을 켜고 끈다(F8).
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'P', altKey: true, shiftKey: true })
    expect(layout().right.collapsed).toBe(true)
    expect(screen.queryByRole('region', { name: en['rail.info'] })).toBeNull()

    fireEvent.keyDown(document.body, { key: 'P', altKey: true, shiftKey: true })
    expect(layout().right.collapsed).toBe(false)
    expect(screen.getByRole('region', { name: en['rail.info'] })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en['explorer.details'] }))
    expect(layout().right.collapsed).toBe(true)
    expect(screen.queryByRole('region', { name: en['rail.info'] })).toBeNull()
  })
})
