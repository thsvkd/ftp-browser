/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useOperationStore } from '@renderer/stores/useOperationStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { TILE_DEFAULT } from '@renderer/lib/explorerLayout'
import { ConfirmDialog } from '@renderer/components/common/ConfirmDialog'
import { en } from '@renderer/i18n/locales/en'
import type { McpState } from '@shared/types/mcp'
import { useThemeSource } from '@renderer/hooks/useThemeSource'
import { SettingsDialog } from './SettingsDialog'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

const mockInvoke = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === 'cache:getStats') {
      return Promise.resolve({ success: true, data: { totalBytes: 0, totalCount: 0 } })
    }
    if (channel === 'update:getState' || channel === 'update:check') {
      return Promise.resolve({
        success: true,
        data: { status: 'idle', currentVersion: '1.0.5' }
      })
    }
    if (channel === 'ftp:getRecentServers') {
      return Promise.resolve({ success: true, data: [] })
    }
    return Promise.resolve({ success: true, data: undefined })
  })
  vi.stubGlobal('api', makeApiMock(mockInvoke))
  useTransferStore.setState({ jobs: [] })
  useOperationStore.setState({ jobs: [] })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SettingsDialog updates', () => {
  it('shows the current version and lets the user check explicitly', async () => {
    // covers: Test-204
    const user = userEvent.setup()
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    expect(await screen.findByText('Version 1.0.5')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: 'Check for updates' }))

    await waitFor(() => {
      expect(invokeCalls(mockInvoke, 'update:check')).toHaveLength(1)
    })
  })

  it('offers download and restart only in the matching updater states', async () => {
    // covers: Test-205
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'cache:getStats') {
        return Promise.resolve({ success: true, data: { totalBytes: 0, totalCount: 0 } })
      }
      if (channel === 'update:getState') {
        return Promise.resolve({
          success: true,
          data: { status: 'available', currentVersion: '1.0.5', availableVersion: '1.0.6' }
        })
      }
      if (channel === 'update:download') {
        return Promise.resolve({
          success: true,
          data: { status: 'ready', currentVersion: '1.0.5', availableVersion: '1.0.6' }
        })
      }
      return Promise.resolve({ success: true, data: undefined })
    })
    const user = userEvent.setup()
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: 'Download 1.0.6' }))
    await user.click(await screen.findByRole('button', { name: 'Restart and update' }))

    expect(invokeCalls(mockInvoke, 'update:download')).toHaveLength(1)
    expect(invokeCalls(mockInvoke, 'update:install')).toHaveLength(1)
  })

  it('does not restart when the user keeps an active transfer running', async () => {
    // covers: Test-210
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'cache:getStats') {
        return Promise.resolve({ success: true, data: { totalBytes: 0, totalCount: 0 } })
      }
      if (channel === 'update:getState') {
        return Promise.resolve({
          success: true,
          data: { status: 'ready', currentVersion: '1.0.5', availableVersion: '1.0.6' }
        })
      }
      return Promise.resolve({ success: true, data: undefined })
    })
    useTransferStore.setState({
      jobs: [
        {
          id: 'active-transfer',
          direction: 'download',
          localPath: 'C:\\photo.jpg',
          remotePath: '/photo.jpg',
          fileName: 'photo.jpg',
          totalBytes: 100,
          transferredBytes: 10,
          status: 'active'
        }
      ]
    })
    const user = userEvent.setup()
    render(
      <>
        <SettingsDialog open={true} onClose={vi.fn()} />
        <ConfirmDialog />
      </>
    )

    await user.click(await screen.findByRole('button', { name: 'Restart and update' }))
    await screen.findByRole('alertdialog')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(invokeCalls(mockInvoke, 'update:install')).toHaveLength(0)
  })

  it('guards the restart when a file operation, not a transfer, is running', async () => {
    // covers: Test-218
    // 전송(useTransferStore)과 파일 작업(useOperationStore)은 별개 큐다. 한쪽만 검증하면
    // 다른 쪽 가드를 지워도 아무 테스트가 깨지지 않는다.
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'cache:getStats') {
        return Promise.resolve({ success: true, data: { totalBytes: 0, totalCount: 0 } })
      }
      if (channel === 'update:getState') {
        return Promise.resolve({
          success: true,
          data: { status: 'ready', currentVersion: '1.0.5', availableVersion: '1.0.6' }
        })
      }
      return Promise.resolve({ success: true, data: undefined })
    })
    useOperationStore.setState({
      jobs: [
        {
          id: 'active-copy',
          kind: 'copy',
          itemCount: 3,
          unit: 'files',
          total: 3,
          completed: 1,
          status: 'active'
        }
      ]
    })
    const user = userEvent.setup()
    render(
      <>
        <SettingsDialog open={true} onClose={vi.fn()} />
        <ConfirmDialog />
      </>
    )

    await user.click(await screen.findByRole('button', { name: 'Restart and update' }))
    await screen.findByRole('alertdialog')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(invokeCalls(mockInvoke, 'update:install')).toHaveLength(0)
  })

  it('applies update states pushed from the main process while open', async () => {
    // covers: Test-219
    // 다운로드 진행률은 IPC 응답이 아니라 main이 밀어주는 이벤트로만 갱신된다. 이 구독이
    // 빠지면 사용자는 0%에서 멈춘 화면을 본다.
    let push: ((...args: unknown[]) => void) | undefined
    const api = makeApiMock(mockInvoke)
    api.on.mockImplementation((_channel, callback) => {
      push = callback
      return () => undefined
    })
    vi.stubGlobal('api', api)
    render(<SettingsDialog open={true} onClose={vi.fn()} />)
    await screen.findByText('Version 1.0.5')

    expect(api.on).toHaveBeenCalledWith('update:stateChanged', expect.any(Function))
    act(() => push?.({ status: 'downloading', currentVersion: '1.0.5', progressPercent: 42.4 }))

    expect(await screen.findByText('Downloading 42%', { selector: 'p' })).not.toBeNull()
  })

  // covers: Test-212
  // updateDescription의 분기는 각 상태에서 사용자가 읽는 유일한 설명이다. 버튼만 검증하면
  // available·ready 밖의 상태(idle·checking·downloading·up-to-date·error·unsupported)는
  // 어떤 단언도 닿지 않는다.
  it.each([
    [{ status: 'idle' }, 'Updates are checked when the app starts.'],
    [{ status: 'checking' }, 'Checking for updates…'],
    [{ status: 'available', availableVersion: '1.0.6' }, 'Version 1.0.6 is available.'],
    [{ status: 'downloading', progressPercent: 42.4 }, 'Downloading 42%'],
    [{ status: 'ready', availableVersion: '1.0.6' }, 'Version 1.0.6 is ready to install.'],
    [{ status: 'up-to-date' }, 'You are using the latest version.'],
    [
      { status: 'error', message: 'network unavailable' },
      "Couldn't check for updates. network unavailable"
    ],
    [{ status: 'error' }, "Couldn't check for updates."],
    // main이 보내는 영어 message 대신 번역된 문구를 보여 준다.
    [
      { status: 'unsupported', message: 'Only on Windows.' },
      'Automatic updates are available only in the installed Windows version.'
    ],
    [
      { status: 'unsupported' },
      'Automatic updates are available only in the installed Windows version.'
    ]
  ])('describes the %o updater state to the user', async (state, expected) => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'cache:getStats') {
        return Promise.resolve({ success: true, data: { totalBytes: 0, totalCount: 0 } })
      }
      if (channel === 'update:getState') {
        return Promise.resolve({ success: true, data: { currentVersion: '1.0.5', ...state } })
      }
      return Promise.resolve({ success: true, data: undefined })
    })
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    // downloading은 설명과 버튼이 같은 문자열을 쓴다. selector로 설명 문단만 겨냥해야
    // updateDescription이 빈 문자열을 돌려줘도 버튼 쪽 텍스트에 가려지지 않는다.
    expect(await screen.findByText(expected, { selector: 'p' })).not.toBeNull()
  })
})

describe('SettingsDialog agent access (MCP)', () => {
  const url = 'http://127.0.0.1:47821/mcp'

  function serveMcpState(
    getState: () => McpState,
    onSetEnabled?: (enabled: boolean) => void
  ): void {
    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'mcp:setEnabled') onSetEnabled?.(args[0] as boolean)
      if (channel === 'mcp:getState' || channel === 'mcp:setEnabled') {
        return Promise.resolve({ success: true, data: getState() })
      }
      return Promise.resolve({ success: true, data: undefined })
    })
  }

  it('turns the server on and shows its endpoint, or the reason it could not start', async () => {
    // covers: Test-252
    let state: McpState = { enabled: false, running: false, url }
    serveMcpState(
      () => state,
      (enabled) => {
        state = { enabled, running: enabled, url, command: 'claude mcp add …' }
      }
    )
    const user = userEvent.setup()
    const { unmount } = render(<SettingsDialog open={true} onClose={vi.fn()} />)

    const toggle = await screen.findByRole('checkbox', { name: /Enable MCP server/ })
    await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false))
    expect(screen.queryByText(`Running at ${url}`)).toBeNull()
    await user.click(toggle)

    expect(invokeCalls(mockInvoke, 'mcp:setEnabled')).toEqual([[true]])
    expect(await screen.findByText(`Running at ${url}`)).not.toBeNull()
    unmount()

    const reason = 'listen EADDRINUSE: address already in use 127.0.0.1:47821'
    state = { enabled: true, running: false, url, error: reason }
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    expect(await screen.findByText(`Couldn't start the server. ${reason}`)).not.toBeNull()
  })

  it('copies the registration command without ever showing the token', async () => {
    // covers: Test-253
    const token = 'tok_SECRET-value_123'
    const command =
      `claude mcp add --scope user --transport http ftp-browser ${url} ` +
      `--header "Authorization: Bearer ${token}"`
    serveMcpState(() => ({ enabled: true, running: true, url, command }))
    const user = userEvent.setup()
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: 'Copy Claude Code command' }))

    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(command))
    expect(document.body.textContent).not.toContain(token)
  })

  it('copies the command that runs the bundled ftpb CLI', async () => {
    // covers: Test-752
    const token = 'tok_SECRET-value_752'
    const cliCommand = "ELECTRON_RUN_AS_NODE=1 '/opt/FTP Browser/ftp-browser' '/opt/cli/ftpb.cjs'"
    serveMcpState(() => ({
      enabled: true,
      running: true,
      url,
      command: `claude mcp add … Bearer ${token}`,
      cliCommand
    }))
    const user = userEvent.setup()
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: 'Copy CLI command' }))

    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(cliCommand))
    expect(toast.success).toHaveBeenCalledWith('CLI command copied')
    expect(document.body.textContent).not.toContain(token)
  })

  it('shows an error toast when toggling or copying fails instead of failing silently', async () => {
    // covers: Test-294
    const command = 'claude mcp add …'
    let setEnabled: () => Promise<unknown> = () =>
      Promise.resolve({ success: false, error: 'SQLITE_BUSY: database is locked' })
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'mcp:getState') {
        return Promise.resolve({
          success: true,
          data: { enabled: true, running: true, url, command }
        })
      }
      if (channel === 'mcp:setEnabled') return setEnabled()
      return Promise.resolve({ success: true, data: undefined })
    })
    const user = userEvent.setup()
    render(<SettingsDialog open={true} onClose={vi.fn()} />)
    const toggle = await screen.findByRole('checkbox', { name: /Enable MCP server/ })
    await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false))

    // 1) 실패 결과
    await user.click(toggle)
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't change agent access", {
        description: 'SQLITE_BUSY: database is locked'
      })
    )
    expect((toggle as HTMLInputElement).checked).toBe(true)

    // 2) invoke 자체의 reject
    vi.mocked(toast.error).mockClear()
    setEnabled = () => Promise.reject(new Error('IPC channel closed'))
    await user.click(toggle)
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't change agent access", {
        description: 'IPC channel closed'
      })
    )

    // 3) 클립보드 쓰기 거부
    vi.mocked(toast.error).mockClear()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
      new Error('Document is not focused.')
    )
    await user.click(screen.getByRole('button', { name: 'Copy Claude Code command' }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't copy the command", {
        description: 'Document is not focused.'
      })
    )
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('SettingsDialog localization', () => {
  afterEach(() => {
    useSettingsStore.setState({ language: 'system' })
  })

  it('renders in Korean when the language setting is ko', async () => {
    useSettingsStore.setState({ language: 'ko' })
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    expect(await screen.findByText('버전 1.0.5')).not.toBeNull()
    expect(screen.getByRole('heading', { name: '설정' })).not.toBeNull()
    expect(screen.getByRole('button', { name: '업데이트 확인' })).not.toBeNull()
    expect(
      screen.getByText('앱을 시작할 때 업데이트를 확인합니다.', { selector: 'p' })
    ).not.toBeNull()
  })
})

describe('SettingsDialog theme', () => {
  afterEach(() => {
    useSettingsStore.setState({ theme: 'system' })
  })

  it('defaults to system, saves the choice and sends it to main on start and on change', async () => {
    // covers: Test-845
    const user = userEvent.setup()
    useSettingsStore.setState({ theme: 'dark' })
    // 앱 셸처럼 테마 동기화 훅을 띄운다
    function Harness(): React.JSX.Element {
      useThemeSource()
      return <SettingsDialog open={true} onClose={vi.fn()} />
    }
    render(<Harness />)

    await waitFor(() => expect(invokeCalls(mockInvoke, 'app:setTheme')).toEqual([['dark']]))
    const select = screen.getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement
    expect(select.value).toBe('dark')
    expect([...select.options].map((o) => [o.value, o.text])).toEqual([
      ['system', 'System default'],
      ['light', 'Light'],
      ['dark', 'Dark']
    ])

    await user.selectOptions(select, 'light')

    expect(useSettingsStore.getState().theme).toBe('light')
    await waitFor(() =>
      expect(invokeCalls(mockInvoke, 'app:setTheme')).toEqual([['dark'], ['light']])
    )
  })

  it('starts from the system theme', () => {
    // covers: Test-845
    useSettingsStore.persist.clearStorage()
    expect(useSettingsStore.getInitialState().theme).toBe('system')
  })
})

describe('SettingsDialog Escape', () => {
  it('closes with Esc even when focus stayed on the button that opened it', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<SettingsDialog open={true} onClose={onClose} />)
    await screen.findByRole('button', { name: 'Check for updates' })

    // 톱니 버튼으로 열면 포커스는 창 밖(body)에 있다.
    ;(document.activeElement as HTMLElement | null)?.blur()
    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('lets Esc close only the confirm dialog stacked on top of it', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <>
        <SettingsDialog open={true} onClose={onClose} />
        <ConfirmDialog />
      </>
    )
    await screen.findByRole('button', { name: 'Check for updates' })
    const { confirmDialog } = await import('@renderer/stores/useConfirmStore')
    let answer: Promise<boolean> | undefined
    act(() => {
      answer = confirmDialog({ title: 'Sure?', confirmLabel: 'OK' })
    })
    await screen.findByRole('alertdialog')

    await user.keyboard('{Escape}')

    await expect(answer).resolves.toBe(false)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('SettingsDialog content sections', () => {
  const savedServers = [
    { id: 1, name: 'NAS', host: 'nas.local', port: 21, username: 'me', secure: false },
    { id: 2, name: 'Backup', host: 'backup.local', port: 21, username: 'me', secure: false }
  ]

  function restoreSettings(): void {
    useSettingsStore.setState({
      viewMode: 'grid',
      tileSize: TILE_DEFAULT,
      showHidden: false,
      confirmBeforeDelete: true,
      language: 'system',
      theme: 'system',
      showSidebar: true,
      showRail: true
    })
    useServerStore.setState({ servers: [] })
  }

  beforeEach(restoreSettings)
  afterEach(restoreSettings)

  it('sets the default view for new tabs from the general segment', async () => {
    // covers: Test-886
    const user = userEvent.setup()
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    const listButton = await screen.findByRole('button', { name: 'List' })
    expect(listButton.getAttribute('aria-pressed')).toBe('false')
    await user.click(listButton)

    expect(useSettingsStore.getState().viewMode).toBe('list')
  })

  it('shows the two display toggles and turns one off through the store', async () => {
    // covers: Test-887
    const user = userEvent.setup()
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    const sidebarToggle = await screen.findByRole('checkbox', { name: 'Show the sidebar' })
    const railToggle = screen.getByRole('checkbox', { name: 'Show the right panel' })
    expect((sidebarToggle as HTMLInputElement).checked).toBe(true)
    expect((railToggle as HTMLInputElement).checked).toBe(true)
    await user.click(sidebarToggle)

    expect(useSettingsStore.getState().showSidebar).toBe(false)
    expect(useSettingsStore.getState().showRail).toBe(true)
  })

  it('shows the saved-server count and password protection, loading servers instead of claiming zero', async () => {
    // covers: Test-888
    let release: () => void = () => undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'ftp:getRecentServers') {
        return pending.then(() => ({ success: true, data: savedServers }))
      }
      if (channel === 'ftp:getPasswordProtection') {
        return Promise.resolve({ success: true, data: { level: 'basic' } })
      }
      if (channel === 'cache:getStats') {
        return Promise.resolve({ success: true, data: { totalBytes: 0, totalCount: 0 } })
      }
      if (channel === 'update:getState') {
        return Promise.resolve({ success: true, data: { status: 'idle', currentVersion: '1.0.5' } })
      }
      return Promise.resolve({ success: true, data: undefined })
    })
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    const account = (await screen.findByRole('heading', { name: 'Account & security' })).closest(
      'section'
    ) as HTMLElement
    // 로드가 끝나기 전에는 "0개"로 단정하지 않고 로드를 부른다(함정 C).
    expect(invokeCalls(mockInvoke, 'ftp:getRecentServers')).toHaveLength(1)
    expect(within(account).getAllByText('Loading…').length).toBeGreaterThan(0)
    expect(within(account).queryByText('0 saved servers')).toBeNull()

    await act(async () => {
      release()
    })

    expect(await within(account).findByText('2 saved servers')).not.toBeNull()
    expect(within(account).getByText('Saved password protection')).not.toBeNull()
    expect(within(account).getByText(en['servers.passwordProtectionBasic'])).not.toBeNull()
  })

  it('shows the cache limit next to the usage', async () => {
    // covers: Test-889
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'cache:getStats') {
        return Promise.resolve({ success: true, data: { totalBytes: 1024, totalCount: 1 } })
      }
      if (channel === 'update:getState') {
        return Promise.resolve({ success: true, data: { status: 'idle', currentVersion: '1.0.5' } })
      }
      return Promise.resolve({ success: true, data: undefined })
    })
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    const cache = (await screen.findByRole('heading', { name: 'Cache' })).closest(
      'section'
    ) as HTMLElement
    expect(await within(cache).findByText('1 item (1 KB)')).not.toBeNull()
    expect(within(cache).getByText('Kept up to 500 MB')).not.toBeNull()
  })

  it('shows platform and versions and copies the one-line diagnostics without any IPC', async () => {
    // covers: Test-890
    vi.stubGlobal('electron', {
      process: { platform: 'win32', versions: { electron: '43.0.0', node: '22.0.0' } }
    })
    const user = userEvent.setup()
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    const about = (await screen.findByRole('heading', { name: 'About' })).closest(
      'section'
    ) as HTMLElement
    expect(within(about).getByText('win32')).not.toBeNull()
    expect(within(about).getByText('1.0.5')).not.toBeNull()
    expect(within(about).getByText('43.0.0')).not.toBeNull()
    expect(within(about).getByText('22.0.0')).not.toBeNull()

    // 정보 섹션은 기존 채널 밖의 IPC를 하나도 쓰지 않는다(새 채널 0개).
    const known = new Set([
      'cache:getStats',
      'update:getState',
      'mcp:getState',
      'ftp:getRecentServers',
      'ftp:getPasswordProtection'
    ])
    expect(mockInvoke.mock.calls.every((call) => known.has(call[0]))).toBe(true)
    const callsBefore = mockInvoke.mock.calls.length
    await user.click(within(about).getByRole('button', { name: 'Copy diagnostics' }))

    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        'FTP Browser 1.0.5 · win32 · electron 43.0.0 · node 22.0.0 · locale en'
      )
    )
    expect(mockInvoke.mock.calls.length).toBe(callsBefore)
    expect(toast.success).toHaveBeenCalledWith('Diagnostics copied')
  })

  it('resets every setting after the confirm dialog and keeps them on cancel', async () => {
    // covers: Test-891
    useSettingsStore.setState({
      viewMode: 'list',
      tileSize: 224,
      showHidden: true,
      confirmBeforeDelete: false,
      theme: 'dark',
      showSidebar: false,
      showRail: false
    })
    const user = userEvent.setup()
    render(
      <>
        <SettingsDialog open={true} onClose={vi.fn()} />
        <ConfirmDialog />
      </>
    )

    await user.click(await screen.findByRole('button', { name: 'Reset all settings' }))
    await screen.findByRole('alertdialog')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(useSettingsStore.getState().viewMode).toBe('list')
    expect(useSettingsStore.getState().theme).toBe('dark')
    expect(useSettingsStore.getState().showSidebar).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Reset all settings' }))
    const confirm = await screen.findByRole('alertdialog')
    await user.click(within(confirm).getByRole('button', { name: 'Reset all settings' }))

    expect(useSettingsStore.getState()).toMatchObject({
      viewMode: 'grid',
      tileSize: TILE_DEFAULT,
      showHidden: false,
      confirmBeforeDelete: true,
      language: 'system',
      theme: 'system',
      showSidebar: true,
      showRail: true
    })
    expect(toast.success).toHaveBeenCalledWith('Settings reset')
  })
})
