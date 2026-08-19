/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import { ConnectDialog } from './ConnectDialog'

const mockInvoke = vi.fn()

function renderDialog(): ReturnType<typeof vi.fn> {
  const onClose = vi.fn()
  render(<ConnectDialog open={true} onClose={onClose} />)
  return onClose
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === 'ftp:getRecentServers' || channel === 'ftp:getRecentPaths') {
      return Promise.resolve({ success: true, data: [] })
    }
    if (channel === 'ftp:disconnect') {
      return Promise.resolve({ success: true, data: undefined })
    }
    if (channel === 'ftp:list') {
      return Promise.resolve({ success: true, data: { path: '/', entries: [] } })
    }
    return Promise.resolve({ success: true, data: undefined })
  })
  vi.stubGlobal('api', makeApiMock(mockInvoke))
  useFtpStore.setState({
    connectionStatus: 'disconnected',
    host: '',
    port: 21,
    error: null,
    currentPath: '/',
    entries: [],
    loading: false,
    history: ['/'],
    historyIndex: 0
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ConnectDialog — cancel during connect', () => {
  it('closes without aborting when no connect is in flight', async () => {
    useFtpStore.setState({ connectionStatus: 'connected', host: 'already.example', port: 21 })
    const user = userEvent.setup()
    const onClose = renderDialog()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(invokeCalls(mockInvoke, 'ftp:disconnect')).toHaveLength(0)
    expect(useFtpStore.getState().host).toBe('already.example')
    expect(useFtpStore.getState().connectionStatus).toBe('connected')
  })

  it('aborts the in-flight connect when Cancel is clicked', async () => {
    let resolveConnect: ((value: { success: true; data: undefined }) => void) | undefined
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'ftp:getRecentServers' || channel === 'ftp:getRecentPaths') {
        return Promise.resolve({ success: true, data: [] })
      }
      if (channel === 'ftp:connect') {
        return new Promise((resolve) => {
          resolveConnect = resolve
        })
      }
      if (channel === 'ftp:disconnect') {
        return Promise.resolve({ success: true, data: undefined })
      }
      if (channel === 'ftp:list') {
        return Promise.resolve({ success: true, data: { path: '/', entries: [] } })
      }
      return Promise.resolve({ success: true, data: undefined })
    })

    const user = userEvent.setup()
    const onClose = renderDialog()

    await user.type(screen.getByPlaceholderText('ftp.example.com'), 'ftp.example.com')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    const connectingButton = await screen.findByRole('button', { name: 'Connecting...' })
    expect(connectingButton.hasAttribute('disabled')).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(invokeCalls(mockInvoke, 'ftp:disconnect')).toHaveLength(1)

    resolveConnect!({ success: true, data: undefined })
    await waitFor(() => {
      expect(useFtpStore.getState().host).toBe('')
      expect(useFtpStore.getState().connectionStatus).toBe('disconnected')
    })
    expect(invokeCalls(mockInvoke, 'ftp:list')).toHaveLength(0)
  })
})
