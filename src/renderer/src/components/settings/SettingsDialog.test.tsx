/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useOperationStore } from '@renderer/stores/useOperationStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { ConfirmDialog } from '@renderer/components/common/ConfirmDialog'
import type { McpState } from '@shared/types/mcp'
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
