/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
})
