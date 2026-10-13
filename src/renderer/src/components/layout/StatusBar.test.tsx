/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { en } from '@renderer/i18n/locales/en'
import { fromLocalEntry } from '@renderer/lib/explorerEntry'
import { EMPTY_FILTER } from '@renderer/lib/fileCategories'
import { useFileCategoryStore } from '@renderer/stores/useFileCategoryStore'
import { useListingStore } from '@renderer/stores/useListingStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import {
  activeTab,
  local,
  localLoc,
  setConnection,
  setupExplorer,
  type ExplorerHarness
} from '@renderer/components/explorer/explorerTestHarness'
import { StatusBar } from './StatusBar'

const DIR = 'C:\\work'
let h: ExplorerHarness
afterEach(() => {
  cleanup()
  h.restore()
})

describe('StatusBar', () => {
  it('shows selection or item count, folder and file totals, hidden count, the tile slider in grid and the connection', () => {
    // covers: Test-824
    h = setupExplorer({ connected: false })
    const entries = [
      local(DIR, 'docs', { dir: true }),
      local(DIR, 'a.jpg', { size: 1024 }),
      local(DIR, 'b.jpg', { size: 2048 }),
      local(DIR, '.env', { size: 10 })
    ].map(fromLocalEntry)
    useListingStore.getState().put(localLoc(DIR), entries)
    useTabsStore.getState().openTab(localLoc(DIR))
    render(<StatusBar />)

    // 선택 없음: 보이는 항목 수, 폴더·파일 합계와 크기, 숨긴 수
    const bar = screen.getByRole('contentinfo')
    expect(bar.textContent).toContain('3 items')
    expect(bar.textContent).toContain('1 folder')
    expect(bar.textContent).toContain('3 files')
    expect(bar.textContent).toContain('3 KB')
    expect(bar.textContent).toContain('1 hidden')

    // 선택: 수와 크기
    act(() =>
      useTabsStore.getState().patchTab(activeTab().id, { sel: [`${DIR}\\a.jpg`, `${DIR}\\b.jpg`] })
    )
    expect(bar.textContent).toContain('2 selected')
    expect(bar.textContent).toMatch(/2 selected\s*·\s*3 KB/)

    // 그리드에서만 타일 크기 조절
    const slider = screen.getByRole('slider', { name: en['status.tileSize'] })
    fireEvent.change(slider, { target: { value: '200' } })
    expect(useSettingsStore.getState().tileSize).toBe(200)
    fireEvent.click(screen.getByRole('button', { name: en['status.tileLarger'] }))
    expect(useSettingsStore.getState().tileSize).toBeGreaterThan(200)
    fireEvent.click(screen.getByRole('button', { name: en['status.tileSmaller'] }))
    expect(useSettingsStore.getState().tileSize).toBe(200)
    act(() => useTabsStore.getState().patchTab(activeTab().id, { view: 'list' }))
    expect(screen.queryByRole('slider')).toBeNull()

    // 연결 상태
    expect(bar.textContent).toContain(en['status.disconnected'])
    act(() => {
      setConnection('me@nas.local:21', 'connected')
      useTabsStore.getState().openTab({ side: 'remote', path: '/', server: 'me@nas.local:21' })
    })
    expect(bar.textContent).toContain(en['status.connected'])
    expect(bar.textContent).toContain('nas.local')
  })

  it('counts with the same type filter as the explorer, and ignores it once its category is hidden', () => {
    // covers: Test-947
    h = setupExplorer({ connected: false })
    const entries = [
      local(DIR, 'docs', { dir: true }),
      local(DIR, 'a.jpg'),
      local(DIR, 'b.jpg'),
      local(DIR, 'c.txt'),
      local(DIR, '.env')
    ].map(fromLocalEntry)
    useListingStore.getState().put(localLoc(DIR), entries)
    useTabsStore.getState().openTab(localLoc(DIR))
    render(<StatusBar />)
    const bar = screen.getByRole('contentinfo')
    expect(bar.textContent).toContain('4 items')
    expect(bar.textContent).toContain('1 hidden')

    act(() =>
      useTabsStore
        .getState()
        .patchTab(activeTab().id, { filter: { ...EMPTY_FILTER, categories: ['image'] } })
    )
    expect(bar.textContent).toContain('3 items')
    expect(bar.textContent).toContain('2 hidden')

    // 설정에서 그 카테고리를 숨기면 필터가 꺼진 것으로 보인다(E15).
    act(() => useFileCategoryStore.getState().setHidden('image', true))
    expect(bar.textContent).toContain('4 items')
    expect(bar.textContent).toContain('1 hidden')
  })

  it("follows the active tab's server, or counts the connected servers on a local tab", () => {
    // covers: Test-1021
    h = setupExplorer({ connected: false })
    const A = 'alice@a.example.com:21'
    const B = 'bob@b.example.com:2121'
    setConnection(A, 'disconnected')
    setConnection(B, 'connected')
    useTabsStore.getState().openTab({ side: 'remote', path: '/', server: B })
    render(<StatusBar />)
    const bar = screen.getByRole('contentinfo')
    expect(bar.textContent).toContain('b.example.com')
    expect(bar.textContent).toContain(en['status.connected'])
    expect(bar.textContent).not.toContain('a.example.com')

    act(() => setConnection(B, 'error'))
    expect(bar.textContent).toContain('b.example.com')
    expect(bar.textContent).toContain(en['status.error'])

    // 로컬 탭: 연결된 서버 수
    act(() => {
      setConnection(A, 'connected')
      setConnection(B, 'connected')
      useTabsStore.getState().openTab(localLoc(DIR))
    })
    expect(bar.textContent).toContain('2 servers connected')
    expect(bar.textContent).not.toContain('b.example.com')

    act(() => {
      setConnection(A, 'disconnected')
      setConnection(B, 'error')
    })
    expect(bar.textContent).toContain(en['status.disconnected'])
    expect(bar.textContent).not.toContain('servers connected')
  })
})
