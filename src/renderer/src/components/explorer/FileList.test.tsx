/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import {
  activeTab,
  ftp,
  local,
  localLoc,
  option,
  remoteLoc,
  renderExplorer,
  selectedNames,
  setupExplorer,
  type ExplorerHarness
} from './explorerTestHarness'

let h: ExplorerHarness

afterEach(() => {
  cleanup()
  h.restore()
})

const columnHeader = (name: string): HTMLElement => {
  const header = screen.getByRole('button', { name }).closest('[role="columnheader"]')
  if (!(header instanceof HTMLElement)) throw new Error(`no column ${name}`)
  return header
}

describe('FileList — virtualization and sorting', () => {
  it('renders only the visible rows of 10,000 and sorts by the clicked column, kept on the tab', async () => {
    // covers: Test-799
    const entries = Array.from({ length: 10_000 }, (_, i) =>
      ftp(`f${String(i).padStart(5, '0')}.txt`, { size: (i * 7919) % 10_000 })
    )
    h = setupExplorer({ remote: { '/big': entries } })
    await renderExplorer(remoteLoc('/big'), { view: 'list' })

    const rendered = screen.getAllByRole('option')
    // 800px 화면에 36px 행: 보이는 22행 남짓 + overscan만 그린다.
    expect(rendered.length).toBeGreaterThan(10)
    expect(rendered.length).toBeLessThan(60)
    expect(columnHeader('Name').getAttribute('aria-sort')).toBe('ascending')

    fireEvent.click(screen.getByRole('button', { name: 'Size' }))
    expect(columnHeader('Size').getAttribute('aria-sort')).toBe('ascending')
    expect(columnHeader('Name').getAttribute('aria-sort')).toBe('none')
    const sizes = screen.getAllByRole('option').map((o) => o.getAttribute('data-path'))
    expect(sizes[0]).toBe('/big/f00000.txt')

    fireEvent.click(screen.getByRole('button', { name: 'Size' }))
    expect(columnHeader('Size').getAttribute('aria-sort')).toBe('descending')
    expect(activeTab().sort).toMatchObject({ key: 'size', dir: 'desc' })
  })
})

// ---------- 이전(§7): 리스트의 플랫폼별 선택 수정자 ----------

async function list(side: 'remote' | 'local', selected: string[], platform: string): Promise<void> {
  if (side === 'remote') {
    h = setupExplorer({ remote: { '/d': [ftp('a.txt'), ftp('b.txt')] } })
    await renderExplorer(remoteLoc('/d'), { view: 'list', sel: selected.map((n) => `/d/${n}`) })
  } else {
    h = setupExplorer({ local: { 'C:\\d': [local('C:\\d', 'a.txt'), local('C:\\d', 'b.txt')] } })
    await renderExplorer(localLoc('C:\\d'), {
      view: 'list',
      sel: selected.map((n) => `C:\\d\\${n}`)
    })
  }
  h.api.platform = platform
}

describe('FileList — platform-aware selection modifiers (migrated)', () => {
  it('single-selects a remote row on Ctrl+click on macOS', async () => {
    // covers: Test-151
    await list('remote', ['b.txt'], 'darwin')
    fireEvent.click(option('a.txt'), { ctrlKey: true })
    expect(selectedNames()).toEqual(['a.txt'])
  })

  it('toggles a remote row on Cmd+click on macOS', async () => {
    // covers: Test-152
    await list('remote', ['b.txt'], 'darwin')
    fireEvent.click(option('a.txt'), { metaKey: true })
    expect(selectedNames()).toEqual(['a.txt', 'b.txt'])
    fireEvent.click(option('a.txt'), { metaKey: true })
    expect(selectedNames()).toEqual(['b.txt'])
  })

  it('single-selects a local row on Ctrl+click on macOS', async () => {
    // covers: Test-147
    await list('local', ['b.txt'], 'darwin')
    fireEvent.click(option('a.txt'), { ctrlKey: true })
    expect(selectedNames()).toEqual(['a.txt'])
  })

  it('toggles a local row on Cmd+click on macOS', async () => {
    // covers: Test-148
    await list('local', ['b.txt'], 'darwin')
    fireEvent.click(option('a.txt'), { metaKey: true })
    expect(selectedNames()).toEqual(['a.txt', 'b.txt'])
    fireEvent.click(option('a.txt'), { metaKey: true })
    expect(selectedNames()).toEqual(['b.txt'])
  })

  it('keeps Ctrl+click toggling on Windows', async () => {
    // covers: Test-155
    await list('local', ['b.txt'], 'win32')
    fireEvent.click(option('a.txt'), { ctrlKey: true })
    expect(selectedNames()).toEqual(['a.txt', 'b.txt'])
  })
})
