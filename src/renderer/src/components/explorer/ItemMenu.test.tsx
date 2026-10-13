/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { en } from '@renderer/i18n/locales/en'
import { fromFtpEntry } from '@renderer/lib/explorerEntry'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { invokeCalls, stubMenuViewport } from '@renderer/test/rendererTestUtils'
import {
  ftp,
  listbox,
  localLoc,
  option,
  remoteLoc,
  renderExplorer,
  server,
  setConnection,
  setupExplorer,
  type ExplorerHarness
} from './explorerTestHarness'
import { ItemMenu, type MenuItem } from './ItemMenu'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() })
}))

const DIR = '/photos'
let h: ExplorerHarness

afterEach(() => {
  cleanup()
  h.restore()
})

const menus = (): HTMLElement[] => screen.queryAllByRole('menu')
const item = (name: string | RegExp): HTMLElement => screen.getByRole('menuitem', { name })
const names = (menu: HTMLElement): string[] =>
  within(menu)
    .getAllByRole('menuitem')
    .map((m) => m.textContent ?? '')

async function photos(): Promise<void> {
  h = setupExplorer({
    remote: { [DIR]: [ftp('sub', { dir: true }), ftp('a.jpg'), ftp('b.jpg')] }
  })
  await renderExplorer(remoteLoc(DIR))
}

describe('ItemMenu — keyboard', () => {
  it('opens on Shift+F10 and the menu key over the focused item, moves with arrows and Home/End, opens the submenu with → and closes with ← and Esc', async () => {
    // covers: Test-795
    // Like a browser, focus() on an element that is still visibility:hidden does nothing.
    const focus = HTMLElement.prototype.focus
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions
    ) {
      if (!this.closest('[style*="visibility: hidden"]')) focus.call(this, options)
    })
    await photos()
    fireEvent.keyDown(listbox(), { key: 'End' })
    fireEvent.keyDown(listbox(), { key: 'F10', shiftKey: true })
    const [menu] = menus()
    expect(menu).toBeTruthy()
    expect(document.activeElement).toBe(menu)

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item(en['menu.preview']))
    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement).toBe(item(en['menu.properties']))
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(document.activeElement).toBe(item(en['menu.preview']))
    // 단축키는 오른쪽에 보이되 이름에는 들어가지 않는다.
    expect(item(en['menu.rename']).getAttribute('aria-keyshortcuts')).toBe('F2')
    expect(item(en['menu.rename']).textContent).toContain('F2')

    while (document.activeElement !== item(en['menu.sendTo']))
      fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'ArrowRight' })
    expect(menus()).toHaveLength(2)
    expect(document.activeElement).toBe(menus()[1])
    expect(item(en['menu.sendTo']).getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(menus()[1], { key: 'ArrowLeft' })
    expect(menus()).toHaveLength(1)
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(menus()).toHaveLength(0)

    fireEvent.keyDown(listbox(), { key: 'ContextMenu' })
    expect(menus()).toHaveLength(1)
    expect(document.activeElement).toBe(menus()[0])
    spy.mockRestore()
  })
})

describe('ItemMenu — contents', () => {
  it('offers open for one folder, preview for a file, disables rename/properties for many and offers removal for shelved items', async () => {
    // covers: Test-801
    await photos()
    fireEvent.contextMenu(option('sub'))
    expect(item(en['menu.open'])).toBeTruthy()
    expect(item(en['menu.openInNewTab'])).toBeTruthy()
    fireEvent.keyDown(menus()[0], { key: 'Escape' })

    fireEvent.contextMenu(option('a.jpg'))
    expect(item(en['menu.preview'])).toHaveProperty('disabled', false)
    expect(screen.queryByRole('menuitem', { name: en['menu.open'] })).toBeNull()
    fireEvent.keyDown(menus()[0], { key: 'Escape' })

    fireEvent.click(option('a.jpg'))
    fireEvent.click(option('b.jpg'), { ctrlKey: true })
    fireEvent.contextMenu(option('a.jpg'))
    expect(item(en['menu.rename'])).toHaveProperty('disabled', true)
    expect(item(en['menu.properties'])).toHaveProperty('disabled', true)
    expect(item('Add 2 to shelf')).toBeTruthy()
    fireEvent.click(item('Add 2 to shelf'))

    fireEvent.contextMenu(option('a.jpg'))
    expect(item(en['menu.removeFromShelf'])).toBeTruthy()
  })

  it('lists open tabs, recent places and Downloads under "Send to", disables invalid ones with the reason, and sends', async () => {
    // covers: Test-802
    await photos()
    act(() => {
      const tabs = useTabsStore.getState()
      tabs.openTab(localLoc('C:\\work'), false)
      useTabsStore.setState({
        recent: [
          remoteLoc(DIR), // 지금 위치는 빠진다
          { side: 'remote', path: '/x', server: 'kim@other:21' },
          ...Array.from({ length: 4 }, (_, i) => localLoc(`C:\\r${i}`))
        ]
      })
    })
    h.handlers['transfer:send'] = () => ({
      success: true,
      data: { batchId: 'b1', ids: ['1'], skipped: [], conflicts: [], totalBytes: 1024 }
    })
    fireEvent.contextMenu(option('a.jpg'))
    fireEvent.click(item(en['menu.sendTo']))
    const sub = menus()[1]
    const labels = names(sub)
    expect(labels[0]).toContain('This PC › work')
    expect(labels.some((l) => l.includes('Downloads'))).toBe(true)
    expect(labels.some((l) => l.includes('photos'))).toBe(false)
    expect(labels.length).toBeLessThanOrEqual(9)
    const other = within(sub).getByRole('menuitem', { name: /other:21 › x/ })
    expect(other).toHaveProperty('disabled', true)
    expect(other.getAttribute('title')).toBe(en['send.invalidNotConnected'])

    fireEvent.click(within(sub).getByRole('menuitem', { name: /Downloads/ }))
    await act(async () => undefined)
    expect(invokeCalls(h.invoke, 'transfer:send')).toEqual([
      [
        server(),
        { direction: 'download', sources: [`${DIR}/a.jpg`], destDir: 'C:\\Users\\me\\Downloads' }
      ]
    ])
  })

  it("offers another connected server's tab as a copy target and a disconnected server's tab disabled", async () => {
    // covers: Test-1026
    const B = 'you@b.example:2121'
    const C = 'kim@c.example:21'
    await photos()
    act(() => {
      setConnection(B, 'connected')
      setConnection(C, 'disconnected')
      const tabs = useTabsStore.getState()
      tabs.openTab({ side: 'remote', path: '/in', server: B }, false)
      tabs.openTab({ side: 'remote', path: '/out', server: C }, false)
    })
    h.handlers['transfer:send'] = () => ({
      success: true,
      data: { batchId: 'b1', ids: ['1'], skipped: [], conflicts: [], totalBytes: 1024 }
    })
    fireEvent.contextMenu(option('a.jpg'))
    fireEvent.click(item(en['menu.sendTo']))
    const sub = menus()[1]

    const offline = within(sub).getByRole('menuitem', { name: /c\.example:21 › out/ })
    expect(offline).toHaveProperty('disabled', true)
    expect(offline.getAttribute('title')).toBe(en['send.invalidNotConnected'])
    const other = within(sub).getByRole('menuitem', { name: /b\.example:2121 › in/ })
    expect(other).toHaveProperty('disabled', false)

    // 고르면 받는 쪽 연결로 서버 간 복사를 보낸다
    fireEvent.click(other)
    await act(async () => undefined)
    expect(invokeCalls(h.invoke, 'transfer:send')).toEqual([
      [B, { direction: 'relay', sourceServer: server(), sources: [`${DIR}/a.jpg`], destDir: '/in' }]
    ])
  })

  it('offers new folder, refresh, select all, dropping the shelf here and copying the current path on empty space', async () => {
    // covers: Test-803
    await photos()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    fireEvent.contextMenu(listbox())
    expect(names(menus()[0]).map((n) => n.replace(/(Ctrl\+.*|F5)$/, ''))).toEqual([
      en['explorer.newFolder'],
      en['toolbar.refresh'],
      en['menu.selectAll'],
      en['menu.shelfEmpty'],
      en['menu.copyCurrentPath']
    ])
    expect(item(en['menu.shelfEmpty'])).toHaveProperty('disabled', true)
    fireEvent.click(item(en['menu.copyCurrentPath']))
    expect(writeText).toHaveBeenCalledWith(DIR)

    act(() => {
      useShelfStore.getState().add([fromFtpEntry(ftp('x.jpg'), '/other', server())])
    })
    fireEvent.contextMenu(listbox())
    expect(item('Drop 1 shelf item here')).toHaveProperty('disabled', false)
  })
})

// ---------- 이전(§7): 메뉴 위치·닫힘 규칙 ----------

const ITEM_MENU: MenuItem[] = [
  { label: 'Rename', onSelect: () => undefined },
  'sep',
  { label: 'Delete' }
]
const FOLDER_MENU: MenuItem[] = [{ label: 'New folder' }, { label: 'Refresh' }]

describe('ItemMenu — viewport clamping (migrated)', () => {
  let viewport: ReturnType<typeof stubMenuViewport>
  beforeEach(() => {
    h = setupExplorer()
    viewport = stubMenuViewport({ width: 160, height: 200 }, { width: 1000, height: 800 })
  })
  afterEach(() => viewport.restore())
  const root = (): HTMLElement => screen.getByRole('menu')
  const open = (items: MenuItem[], x: number, y: number): ReturnType<typeof render> =>
    render(<ItemMenu x={x} y={y} label="menu" items={items} onClose={vi.fn()} />)

  it('flips the item menu upward near the bottom edge', () => {
    // covers: Test-104
    open(ITEM_MENU, 10, 700)
    expect(root().style.top).toBe('500px')
  })

  it('flips the empty-space menu upward near the bottom edge', () => {
    // covers: Test-105
    open(FOLDER_MENU, 10, 700)
    expect(root().style.top).toBe('500px')
  })

  it('keeps the anchor when the menu fits', () => {
    // covers: Test-106
    open(ITEM_MENU, 10, 10)
    expect(root().style.left).toBe('10px')
    expect(root().style.top).toBe('10px')
  })

  it('recomputes the position on every reopen', () => {
    // covers: Test-108
    const { rerender } = open(ITEM_MENU, 10, 700)
    expect(root().style.top).toBe('500px')
    rerender(<ItemMenu x={10} y={10} label="menu" items={ITEM_MENU} onClose={vi.fn()} />)
    expect(root().style.top).toBe('10px')
  })
})

describe('ItemMenu — dismiss triggers (migrated)', () => {
  let onClose: ReturnType<typeof vi.fn<() => void>>
  beforeEach(() => {
    h = setupExplorer()
    onClose = vi.fn<() => void>()
    render(<ItemMenu x={10} y={10} label="menu" items={ITEM_MENU} onClose={onClose} />)
  })

  it('closes on an outside left click', () => {
    // covers: Test-109
    fireEvent.click(document.body)
    expect(onClose).toHaveBeenCalled()
  })

  it('does not close on a click inside the menu', () => {
    // covers: Test-110
    fireEvent.click(screen.getByRole('menu'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    // covers: Test-111
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on an outside right click', () => {
    // covers: Test-112
    fireEvent.contextMenu(document.body)
    expect(onClose).toHaveBeenCalled()
  })

  it('does not close on a right click inside the menu', () => {
    // covers: Test-113
    fireEvent.contextMenu(screen.getByRole('menu'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes when the window loses focus', () => {
    // covers: Test-115
    fireEvent.blur(window)
    expect(onClose).toHaveBeenCalled()
  })

  it('closes when a scroll container outside the menu scrolls', () => {
    // covers: Test-116
    const box = document.createElement('div')
    document.body.appendChild(box)
    try {
      fireEvent.scroll(box)
      expect(onClose).toHaveBeenCalled()
    } finally {
      box.remove()
    }
  })
})

// ---------- 메뉴를 연 click이 그 메뉴를 닫지 않는다(explorer-menu-and-focus M1) ----------

describe('ItemMenu — the opening click', () => {
  // act 밖의 네이티브 이벤트: 메뉴가 이벤트 전파 도중에 마운트되는 실제 순서를 만든다(§8 함정 1).
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  let saved: boolean | undefined
  let opened: { root: Root; hosts: HTMLElement[] } | null = null
  const closeAll = (): void => {
    opened?.root.unmount()
    opened?.hosts.forEach((el) => el.remove())
    opened = null
  }
  beforeEach(() => {
    h = setupExplorer()
    saved = env.IS_REACT_ACT_ENVIRONMENT
    env.IS_REACT_ACT_ENVIRONMENT = false
  })
  afterEach(() => {
    closeAll()
    env.IS_REACT_ACT_ENVIRONMENT = saved
  })

  const nativeClick = (el: Element, type = 'click'): void => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
  }
  /** 버튼의 네이티브 click 리스너가 그 click 안에서 메뉴를 다른 루트에 동기로 그린다. */
  function openByClick(onClose: () => void): void {
    const host = document.createElement('div')
    const button = document.createElement('button')
    host.appendChild(button)
    const menuHost = document.createElement('div')
    document.body.append(host, menuHost)
    const root = createRoot(menuHost)
    opened = { root, hosts: [host, menuHost] }
    host.addEventListener('click', () =>
      flushSync(() =>
        root.render(<ItemMenu x={10} y={10} label="menu" items={ITEM_MENU} onClose={onClose} />)
      )
    )
    nativeClick(button)
  }

  it('does not close on the very click that opened it', () => {
    // covers: Test-846
    const onClose = vi.fn<() => void>()
    openByClick(onClose)
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(onClose).toHaveBeenCalledTimes(0)
  })

  it('still closes on later outside clicks and right clicks, not on inside ones', () => {
    // covers: Test-847
    const onClose = vi.fn<() => void>()
    openByClick(onClose)
    expect(onClose).toHaveBeenCalledTimes(0)
    nativeClick(screen.getByRole('menu'))
    expect(onClose).toHaveBeenCalledTimes(0)
    nativeClick(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)

    closeAll()
    const again = vi.fn<() => void>()
    openByClick(again)
    expect(again).toHaveBeenCalledTimes(0)
    nativeClick(screen.getByRole('menu'), 'contextmenu')
    expect(again).toHaveBeenCalledTimes(0)
    nativeClick(document.body, 'contextmenu')
    expect(again).toHaveBeenCalledTimes(1)
  })
})
