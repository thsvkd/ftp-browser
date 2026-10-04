/** @vitest-environment jsdom */
/**
 * GUI 접근성(handoff agent-friendly §2.3 A1–A4). Playwright MCP·OS 접근성 API처럼 화면을
 * 조작하는 에이전트는 접근성 트리의 role과 이름으로 컨트롤을 찾으므로, 둘을 role 쿼리로 고정한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { useSelectionStore } from '@renderer/stores/useSelectionStore'
import { useLocalSelectionStore } from '@renderer/stores/useLocalSelectionStore'
import { useOperationStore } from '@renderer/stores/useOperationStore'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import { en } from '@renderer/i18n/locales/en'
import type { FtpFileEntry } from '@shared/types/ftp'
import type { LocalFileEntry } from '@shared/types/local'
import type { OperationJob } from '@shared/types/operation'
import { AppShell } from './layout/AppShell'
import { StatusBar } from './layout/StatusBar'
import { LocalBreadcrumb } from './local/LocalBreadcrumb'
import { LocalFileContextMenu } from './local/LocalFileContextMenu'
import { LocalFilePropertiesDialog } from './local/LocalFilePropertiesDialog'
import { FileContextMenu } from './remote/FileContextMenu'
import { FilePropertiesDialog } from './remote/FilePropertiesDialog'
import { RemoteBreadcrumb } from './remote/RemoteBreadcrumb'
import { SettingsDialog } from './settings/SettingsDialog'
import { ImagePreviewModal } from './thumbnail/ImagePreviewModal'
import { OperationPanel } from './transfer/OperationPanel'

const mockInvoke = vi.fn()
const MODIFIED_AT = '2024-05-01T10:20:30.000Z'

function ftpEntry(name: string, type: FtpFileEntry['type'] = 'file'): FtpFileEntry {
  return {
    name,
    type,
    size: 1024,
    modifiedAt: MODIFIED_AT,
    rawModifiedAt: MODIFIED_AT,
    isImage: name.endsWith('.jpg')
  }
}

function localEntry(name: string, type: LocalFileEntry['type'] = 'file'): LocalFileEntry {
  return {
    name,
    path: `C:\\work\\${name}`,
    type,
    size: 1024,
    modifiedAt: MODIFIED_AT,
    isImage: name.endsWith('.jpg')
  }
}

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

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === 'cache:getStats') {
      return Promise.resolve({ success: true, data: { totalBytes: 2048, totalCount: 3 } })
    }
    if (channel === 'update:getState') {
      return Promise.resolve({ success: true, data: { status: 'idle', currentVersion: '1.0.5' } })
    }
    if (channel === 'ftp:getRecentServers' || channel === 'ftp:getRecentPaths') {
      return Promise.resolve({ success: true, data: [] })
    }
    return Promise.resolve({ success: true, data: undefined })
  })
  vi.stubGlobal('api', makeApiMock(mockInvoke))
  useFtpStore.setState({
    connectionStatus: 'connected',
    host: 'example.org',
    port: 21,
    currentPath: '/photos',
    entries: [],
    loading: false,
    error: null,
    history: ['/', '/photos'],
    historyIndex: 1
  })
  // currentPath가 있으면 LocalExplorer의 init()이 돌지 않는다.
  useLocalFsStore.setState({
    currentPath: 'C:\\work',
    entries: [],
    loading: false,
    error: null,
    history: ['C:\\', 'C:\\work'],
    historyIndex: 1
  })
  useSelectionStore.setState({ selectedNames: new Set(), lastClickedName: null })
  useLocalSelectionStore.setState({ selectedNames: new Set(), lastClickedName: null })
  useTransferStore.setState({ jobs: [] })
  useOperationStore.setState({ jobs: [] })
  useSettingsStore.setState({
    remoteViewMode: 'list',
    localViewMode: 'list',
    showHidden: false,
    confirmBeforeDelete: false
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('GUI accessibility — dialogs', () => {
  it('finds the image preview close button by its name', async () => {
    // covers: Test-254
    const onClose = vi.fn()
    render(<ImagePreviewModal entry={ftpEntry('a.jpg')} onClose={onClose} />)

    const dialog = screen.getByRole('dialog', { name: 'a.jpg' })
    await userEvent.setup().click(within(dialog).getByRole('button', { name: en['common.close'] }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(en['preview.none'])).toBeTruthy()
  })

  it('exposes the remote and local properties dialogs by name with a named close button', () => {
    // covers: Test-255
    const expectPropertiesDialog = (): void => {
      const dialog = screen.getByRole('dialog', { name: en['properties.title'] })
      // 헤더의 X 아이콘과 하단의 텍스트 버튼, 둘 다 닫기다.
      expect(within(dialog).getAllByRole('button', { name: en['common.close'] })).toHaveLength(2)
      expect(unnamedButtons()).toEqual([])
    }

    const { unmount } = render(<FilePropertiesDialog entry={ftpEntry('a.txt')} onClose={vi.fn()} />)
    expectPropertiesDialog()
    unmount()

    render(<LocalFilePropertiesDialog entry={localEntry('a.txt')} onClose={vi.fn()} />)
    expectPropertiesDialog()
  })

  it('exposes the settings dialog by its title', async () => {
    // covers: Test-256
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: en['settings.title'] })).toBeTruthy()
    expect(await screen.findByText('Version 1.0.5')).toBeTruthy()
  })
})

describe('GUI accessibility — icon-only buttons', () => {
  it('finds the file operation cancel button by its name', async () => {
    // covers: Test-257
    useOperationStore.setState({ jobs: [activeOperation] })
    render(<OperationPanel />)

    await userEvent.setup().click(screen.getByRole('button', { name: en['common.cancel'] }))

    expect(invokeCalls(mockInvoke, 'operation:cancel')).toEqual([['op-1']])
  })

  it('labels breadcrumb back/forward with aria-label and leaves no unnamed button', () => {
    // covers: Test-258
    for (const Breadcrumb of [RemoteBreadcrumb, LocalBreadcrumb]) {
      const { container, unmount } = render(<Breadcrumb />)

      const back = screen.getByRole('button', { name: en['explorer.back'] })
      const forward = screen.getByRole('button', { name: en['explorer.forward'] })
      expect(back.getAttribute('aria-label')).toBe(en['explorer.back'])
      expect(forward.getAttribute('aria-label')).toBe(en['explorer.forward'])
      expect(unnamedButtons()).toEqual([])

      // 더블클릭으로 들어가는 경로 입력 모드에서도 이름 없는 버튼이 남지 않는다.
      fireEvent.doubleClick(container.firstElementChild as HTMLElement)
      expect(screen.getByRole('textbox')).toBeTruthy()
      expect(unnamedButtons()).toEqual([])
      unmount()
    }
  })

  it('finds the status bar clear-cache button by its name', async () => {
    // covers: Test-259
    render(<StatusBar />)

    const button = await screen.findByRole('button', { name: en['status.clearCache'] })
    expect(button.getAttribute('aria-label')).toBe(en['status.clearCache'])
  })
})

describe('GUI accessibility — context menus', () => {
  it('exposes the remote and local context menus as menus of menu items', () => {
    // covers: Test-260
    const expectMenuItems = (names: string[]): void => {
      const menu = screen.getByRole('menu')
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((item) => item.textContent)
      ).toEqual(names)
      expect(within(menu).queryAllByRole('button')).toEqual([])
    }

    const remote = ftpEntry('a.txt')
    useFtpStore.setState({ entries: [remote] })
    useSelectionStore.setState({ selectedNames: new Set(['a.txt']) })
    const { unmount } = render(
      <FileContextMenu
        entry={remote}
        position={{ x: 10, y: 10 }}
        onClose={vi.fn()}
        onShowProperties={vi.fn()}
      />
    )
    expectMenuItems([
      en['menu.download'],
      en['menu.rename'],
      en['common.delete'],
      en['menu.newFolder'],
      en['menu.properties']
    ])
    unmount()

    const local = localEntry('a.txt')
    useLocalFsStore.setState({ entries: [local] })
    useLocalSelectionStore.setState({ selectedNames: new Set(['a.txt']) })
    render(
      <LocalFileContextMenu
        entry={local}
        position={{ x: 10, y: 10 }}
        onClose={vi.fn()}
        onShowProperties={vi.fn()}
      />
    )
    expectMenuItems([
      en['menu.upload'],
      en['menu.rename'],
      en['common.delete'],
      en['menu.newFolder'],
      en['menu.properties']
    ])
  })
})

describe('GUI accessibility — regression guard', () => {
  it('leaves no button without an accessible name on the main window and settings', async () => {
    // covers: Test-261
    useFtpStore.setState({ entries: [ftpEntry('albums', 'directory'), ftpEntry('a.jpg')] })
    useLocalFsStore.setState({ entries: [localEntry('docs', 'directory'), localEntry('b.jpg')] })
    useOperationStore.setState({ jobs: [activeOperation] })
    useTransferStore.setState({
      jobs: [
        {
          id: 't-1',
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

    // 접힌 전송 패널을 펼치고, 설정 대화상자를 툴바에서 연다.
    await user.click(screen.getByText(/Transfers/))
    expect(screen.getByRole('button', { name: 'Cancel big.bin' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: en['settings.title'] }))
    expect(await screen.findByText('Version 1.0.5')).toBeTruthy()
    expect(await screen.findByRole('button', { name: en['status.clearCache'] })).toBeTruthy()

    expect(unnamedButtons()).toEqual([])
  })
})
