/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useOperationStore } from '@renderer/stores/useOperationStore'
import { SettingsDialog } from './SettingsDialog'

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
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: 'Restart and update' }))

    expect(confirm).toHaveBeenCalled()
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
          label: 'Copying 3 files',
          unit: 'files',
          total: 3,
          completed: 1,
          status: 'active'
        }
      ]
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()
    render(<SettingsDialog open={true} onClose={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: 'Restart and update' }))

    expect(confirm).toHaveBeenCalled()
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
    [{ status: 'checking' }, 'Checking for updates...'],
    [{ status: 'available', availableVersion: '1.0.6' }, 'Version 1.0.6 is available.'],
    [{ status: 'downloading', progressPercent: 42.4 }, 'Downloading 42%'],
    [{ status: 'ready', availableVersion: '1.0.6' }, 'Version 1.0.6 is ready to install.'],
    [{ status: 'up-to-date' }, 'You are using the latest version.'],
    [{ status: 'error', message: 'network unavailable' }, 'network unavailable'],
    [{ status: 'error' }, 'Update check failed.'],
    [{ status: 'unsupported', message: 'Only on Windows.' }, 'Only on Windows.'],
    [{ status: 'unsupported' }, 'Automatic updates are not available for this build.']
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
