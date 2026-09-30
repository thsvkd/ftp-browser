/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useServerStore } from '@renderer/stores/useServerStore'
import { emptyDraft, toDraft } from '@renderer/lib/serverAddress'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import type { FtpServer } from '@shared/types/ftp'
import { ServerManagerDialog } from './ServerManagerDialog'

const mockInvoke = vi.fn()

const NAS: FtpServer = {
  id: 1,
  name: 'Home NAS',
  host: 'nas.local',
  port: 21,
  username: '',
  password: '',
  secure: false,
  maxTransfers: 6
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
    if (channel === 'ftp:getRecentServers') return Promise.resolve({ success: true, data: [NAS] })
    if (channel === 'ftp:getRecentPaths') return Promise.resolve({ success: true, data: [] })
    if (channel === 'ftp:saveServer') {
      return Promise.resolve({ success: true, data: { ...(args[0] as FtpServer), id: 1 } })
    }
    return Promise.resolve({ success: true, data: undefined })
  })
  vi.stubGlobal('api', makeApiMock(mockInvoke))
  useServerStore.setState({
    servers: [NAS],
    draft: emptyDraft(),
    address: '',
    connecting: false,
    error: ''
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const transfersInput = (): HTMLInputElement =>
  screen.getByLabelText('Simultaneous transfers') as HTMLInputElement

describe('ServerManagerDialog — simultaneous transfers', () => {
  it('shows a saved server value, and 16 for a new server', async () => {
    const { unmount } = render(<ServerManagerDialog initial={toDraft(NAS)} onClose={vi.fn()} />)
    expect(transfersInput().value).toBe('6')
    expect(screen.getByText(/lowered automatically if the server refuses/i)).toBeTruthy()
    unmount()

    render(<ServerManagerDialog initial={emptyDraft()} onClose={vi.fn()} />)
    expect(transfersInput().value).toBe('16')
  })

  it('saves the edited value with the server', async () => {
    const user = userEvent.setup()
    render(<ServerManagerDialog initial={toDraft(NAS)} onClose={vi.fn()} />)

    await user.clear(transfersInput())
    await user.type(transfersInput(), '12')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:saveServer')).toHaveLength(1))
    expect(invokeCalls(mockInvoke, 'ftp:saveServer')[0][0]).toMatchObject({
      id: 1,
      host: 'nas.local',
      maxTransfers: 12
    })
  })

  it('refuses a value outside 1..20 without saving or connecting', async () => {
    const user = userEvent.setup()
    render(<ServerManagerDialog initial={toDraft(NAS)} onClose={vi.fn()} />)

    for (const bad of ['0', '21']) {
      await user.clear(transfersInput())
      await user.type(transfersInput(), bad)
      expect(transfersInput().getAttribute('aria-invalid')).toBe('true')

      await user.click(screen.getByRole('button', { name: 'Save' }))
      expect((await screen.findByRole('alert')).textContent).toContain('1 to 20')
      await user.click(screen.getByRole('button', { name: 'Connect' }))
    }

    expect(invokeCalls(mockInvoke, 'ftp:saveServer')).toHaveLength(0)
    expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(0)
  })

  it('treats an empty field as the default of 16', async () => {
    const user = userEvent.setup()
    render(<ServerManagerDialog initial={toDraft(NAS)} onClose={vi.fn()} />)

    await user.clear(transfersInput())
    expect(transfersInput().getAttribute('aria-invalid')).toBe('false')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:saveServer')).toHaveLength(1))
    expect(invokeCalls(mockInvoke, 'ftp:saveServer')[0][0]).toMatchObject({ maxTransfers: 16 })
  })
})
