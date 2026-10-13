/** @vitest-environment jsdom */
/**
 * GUI 접근성(handoff agent-access K8). Playwright MCP·OS 접근성 API처럼 화면을
 * 조작하는 에이전트는 접근성 트리의 role과 이름으로 컨트롤을 찾으므로, 둘을 role 쿼리로 고정한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useOperationStore } from '@renderer/stores/useOperationStore'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { invokeCalls } from '@renderer/test/rendererTestUtils'
import { en } from '@renderer/i18n/locales/en'
import { fromFtpEntry, fromLocalEntry } from '@renderer/lib/explorerEntry'
import { optId } from '@renderer/lib/explorerLayout'
import type { OperationJob } from '@shared/types/operation'
import {
  ftp,
  localLoc,
  local,
  option,
  remoteLoc,
  renderExplorer,
  server,
  setupExplorer,
  type ExplorerHarness
} from './explorer/explorerTestHarness'
import { ActivityPill } from './activity/ActivityPill'
import { Lightbox } from './explorer/Lightbox'
import { PropertiesDialog } from './explorer/PropertiesDialog'
import { AppShell } from './layout/AppShell'
import { SettingsDialog } from './settings/SettingsDialog'

const activeOperation: OperationJob = {
  id: 'op-1',
  kind: 'copy',
  itemCount: 1,
  itemName: 'a.jpg',
  unit: 'files',
  total: 4,
  completed: 1,
  status: 'active'
}

/** 접근 가능한 이름이 빈 버튼. 실패 메시지에서 어느 버튼인지 보이도록 outerHTML로 돌려준다. */
function unnamedButtons(): string[] {
  return screen
    .queryAllByRole('button', { name: (name) => name.trim() === '' })
    .map((button) => button.outerHTML)
}

/** 셸 전체를 그리는 테스트의 준비. 탐색기 묶음은 각자 다시 준비한다. */
let shell: ExplorerHarness
beforeEach(() => {
  vi.clearAllMocks()
  shell = setupExplorer({ local: { 'C:\\work': [] } })
  shell.handlers['cache:getStats'] = () => ({
    success: true,
    data: { totalBytes: 2048, totalCount: 3 }
  })
  shell.handlers['update:getState'] = () => ({
    success: true,
    data: { status: 'idle', currentVersion: '1.0.5' }
  })
  shell.handlers['local:getHome'] = () => ({ success: true, data: 'C:\\work' })
  useOperationStore.setState({ jobs: [] })
})

afterEach(() => {
  cleanup()
  shell.restore()
})

describe('GUI accessibility — dialogs', () => {
  it('finds the lightbox close button by its name', async () => {
    // covers: Test-254
    const onClose = vi.fn()
    const entry = fromFtpEntry(ftp('a.jpg'), '/photos', server())
    render(<Lightbox items={[entry]} index={0} onIndex={vi.fn()} onClose={onClose} />)

    const dialog = screen.getByRole('dialog', { name: 'Preview: a.jpg' })
    await userEvent.setup().click(within(dialog).getByRole('button', { name: en['common.close'] }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(en['preview.none'])).toBeTruthy()
  })

  it.each([
    ['remote', fromFtpEntry(ftp('a.txt'), '/photos', 'me@nas:21')],
    ['local', fromLocalEntry(local('C:\\work', 'a.txt'))]
  ] as const)('exposes the %s properties dialog by name with a named close button', (_, entry) => {
    // covers: Test-255
    render(<PropertiesDialog entry={entry} onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: en['properties.title'] })
    // 헤더의 X 아이콘과 하단의 텍스트 버튼, 둘 다 닫기다.
    expect(within(dialog).getAllByRole('button', { name: en['common.close'] })).toHaveLength(2)
    expect(unnamedButtons()).toEqual([])
  })

  it('exposes the settings dialog by its title', async () => {
    // covers: Test-256
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: en['settings.title'] })).toBeTruthy()
    expect(await screen.findByText('Version 1.0.5')).toBeTruthy()
  })
})

describe('GUI accessibility — icon-only buttons', () => {
  const openActivity = async (): Promise<void> => {
    render(<ActivityPill />)
    await userEvent.setup().click(screen.getByRole('button', { name: /^Activity/ }))
  }

  it('finds the file operation cancel button in the activity popover by its name', async () => {
    // covers: Test-257
    useOperationStore.setState({ jobs: [activeOperation] })
    await openActivity()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel: Copying "a.jpg"' }))

    expect(invokeCalls(shell.invoke, 'operation:cancel')).toEqual([['op-1']])
  })

  it('names each active file operation cancel button after its operation', async () => {
    // covers: Test-299
    useOperationStore.setState({
      jobs: [
        activeOperation,
        { ...activeOperation, id: 'op-2', kind: 'delete', itemName: undefined, itemCount: 3 }
      ]
    })
    await openActivity()

    const cancelCopy = screen.getByRole('button', { name: 'Cancel: Copying "a.jpg"' })
    const cancelDelete = screen.getByRole('button', { name: 'Cancel: Deleting 3 items' })
    await userEvent.setup().click(cancelDelete)

    expect(cancelCopy).not.toBe(cancelDelete)
    expect(invokeCalls(shell.invoke, 'operation:cancel')).toEqual([['op-2']])
  })
})

describe('GUI accessibility — regression guard', () => {
  it('leaves no button without an accessible name on the main window, activity and settings', async () => {
    // covers: Test-261
    shell.local['C:\\work'] = [local('C:\\work', 'docs', { dir: true }), local('C:\\work', 'b.jpg')]
    useOperationStore.setState({ jobs: [activeOperation] })
    useTransferStore.setState({
      jobs: [
        {
          id: 't-1',
          server: 'me@nas.local:21',
          direction: 'upload',
          fileName: 'big.bin',
          localPath: 'C:\\work\\big.bin',
          remotePath: '/photos/big.bin',
          totalBytes: 100,
          transferredBytes: 40,
          status: 'active'
        }
      ]
    })
    const user = userEvent.setup()
    render(<AppShell />)
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    expect(unnamedButtons()).toEqual([])

    // 활동 팝오버를 열고 닫은 뒤, 설정 대화상자를 툴바에서 연다.
    await user.click(screen.getByRole('button', { name: /^Activity/ }))
    expect(screen.getByRole('button', { name: en['transfer.cancelBatch'] })).toBeTruthy()
    expect(unnamedButtons()).toEqual([])
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: en['settings.title'] }))
    expect(await screen.findByText('Version 1.0.5')).toBeTruthy()
    expect(await screen.findByRole('button', { name: en['settings.clearCache'] })).toBeTruthy()

    expect(unnamedButtons()).toEqual([])
  })
})

// ---------- 새 탐색기(Shelf) ----------

describe('GUI accessibility — explorer', () => {
  let h: ExplorerHarness
  beforeEach(() => shell.restore())
  // 언마운트(사라지는 원격 패널의 뷰어 취소, split-view §4 17행)가 목을 되돌리기 전에 일어나야 한다.
  afterEach(() => {
    cleanup()
    h.restore()
  })

  it('names the one explorer region after the active tab’s side and exposes a multiselect listbox of options', async () => {
    // covers: Test-800
    h = setupExplorer({ remote: { '/photos': [ftp('a.jpg'), ftp('b.jpg')] } })
    await renderExplorer(remoteLoc('/photos'), { sel: ['/photos/b.jpg'], focus: '/photos/b.jpg' })
    const region = screen.getByRole('region', { name: en['explorer.remote'] })
    const list = within(region).getByRole('listbox')
    expect(list.getAttribute('aria-multiselectable')).toBe('true')
    const options = within(list).getAllByRole('option')
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true'])
    expect(list.getAttribute('aria-activedescendant')).toBe(optId('/photos/b.jpg'))
    expect(screen.queryByRole('region', { name: en['explorer.local'] })).toBeNull()

    cleanup()
    h.restore()
    h = setupExplorer({ local: { 'C:\\work': [local('C:\\work', 'a.txt')] } })
    await renderExplorer(localLoc('C:\\work'))
    expect(screen.getByRole('region', { name: en['explorer.local'] })).toBeTruthy()
  })

  it('names the path bar’s back, forward and up buttons, has a textbox while typing a path and no unnamed button', async () => {
    // covers: Test-832
    h = setupExplorer({ remote: { '/photos': [ftp('a.jpg')] } })
    await renderExplorer(remoteLoc('/photos'))
    expect(screen.getByRole('button', { name: en['explorer.back'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: en['explorer.forward'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: en['path.up'] })).toBeTruthy()
    expect(unnamedButtons()).toEqual([])
    fireEvent.click(screen.getByRole('navigation', { name: en['path.label'] }))
    expect(screen.getByRole('textbox', { name: en['path.edit'] })).toBeTruthy()
    expect(unnamedButtons()).toEqual([])
  })

  it('exposes the item menu and its submenu as menus of only menu items and separators', async () => {
    // covers: Test-833
    h = setupExplorer({ remote: { '/photos': [ftp('a.jpg')] } })
    await renderExplorer(remoteLoc('/photos'))
    fireEvent.contextMenu(option('a.jpg'))
    fireEvent.click(screen.getByRole('menuitem', { name: en['menu.sendTo'] }))
    const menus = screen.getAllByRole('menu')
    expect(menus).toHaveLength(2)
    for (const menu of menus) {
      const roles = [...menu.children].map((c) => c.getAttribute('role'))
      expect(roles.length).toBeGreaterThan(0)
      expect(roles.every((r) => r === 'menuitem' || r === 'separator')).toBe(true)
    }
  })
})
