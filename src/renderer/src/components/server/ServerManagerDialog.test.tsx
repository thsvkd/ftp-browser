/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useServerStore } from '@renderer/stores/useServerStore'
import { emptyDraft, toDraft } from '@renderer/lib/serverAddress'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import type { FtpServer, FtpServerInput, PasswordProtection } from '@shared/types/ftp'
import { ServerManagerDialog } from './ServerManagerDialog'

const mockInvoke = vi.fn()

const NAS: FtpServer = {
  id: 1,
  name: 'Home NAS',
  host: 'nas.local',
  port: 21,
  username: '',
  hasPassword: false,
  secure: false,
  maxTransfers: 6
}

/** NAS with a saved login. */
const LOCKED: FtpServer = { ...NAS, username: 'me', hasPassword: true }

/** Saved servers main answers with; a test replaces it before rendering. */
let saved: FtpServer[] = [NAS]
let protection: PasswordProtection['level'] = 'keyring'

/** What main would save: `password` undefined keeps the saved one, '' removes it. */
function savedFrom(input: FtpServerInput): FtpServer {
  const { password, ...fields } = input
  const before = saved.find((s) => s.id === input.id)
  return {
    ...fields,
    id: input.id ?? 2,
    hasPassword: password === undefined ? (before?.hasPassword ?? false) : password !== ''
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  saved = [NAS]
  protection = 'keyring'
  mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
    if (channel === 'ftp:getRecentServers') return Promise.resolve({ success: true, data: saved })
    if (channel === 'ftp:getRecentPaths') return Promise.resolve({ success: true, data: [] })
    if (channel === 'ftp:getPasswordProtection') {
      return Promise.resolve({ success: true, data: { level: protection } })
    }
    if (channel === 'ftp:saveServer') {
      return Promise.resolve({ success: true, data: savedFrom(args[0] as FtpServerInput) })
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

describe('ServerManagerDialog — saved password', () => {
  const passwordField = (): HTMLInputElement =>
    screen.getByLabelText('Password') as HTMLInputElement
  const savePayload = (i: number): FtpServerInput =>
    invokeCalls(mockInvoke, 'ftp:saveServer')[i][0] as FtpServerInput

  beforeEach(() => {
    saved = [LOCKED]
    useServerStore.setState({ servers: [LOCKED] })
  })

  it('saves the typed password, leaves it out to keep the saved one, and none for a new server', async () => {
    // covers: Test-723
    const user = userEvent.setup()
    render(<ServerManagerDialog initial={toDraft(LOCKED)} onClose={vi.fn()} />)

    // 비밀번호 칸을 건드리지 않으면 저장된 비밀번호를 그대로 둔다.
    await user.clear(screen.getByLabelText(/^Name/))
    await user.type(screen.getByLabelText(/^Name/), 'Home')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:saveServer')).toHaveLength(1))
    expect(savePayload(0)).toMatchObject({ id: 1, name: 'Home', username: 'me' })
    expect(savePayload(0).password).toBeUndefined()
    expect(passwordField().placeholder).toBe('Saved password')

    await user.type(passwordField(), 'new-pw')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:saveServer')).toHaveLength(2))
    expect(savePayload(1)).toMatchObject({ id: 1, password: 'new-pw' })
    // 저장하고 나면 입력값은 칸에서 사라지고 저장된 비밀번호로 표시된다.
    expect(passwordField().value).toBe('')

    await user.click(screen.getByRole('button', { name: 'New server' }))
    await user.type(screen.getByLabelText('Host'), 'other.local')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:saveServer')).toHaveLength(3))
    expect(savePayload(2)).toMatchObject({ host: 'other.local', password: '' })
    expect(savePayload(2).id).toBeUndefined()
  })

  it('removes the saved password with its button, and saving then sends an empty one', async () => {
    // covers: Test-725
    const user = userEvent.setup()
    render(<ServerManagerDialog initial={toDraft(LOCKED)} onClose={vi.fn()} />)
    expect(screen.queryByText('Modified')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Remove saved password' }))

    expect(screen.queryByRole('button', { name: 'Remove saved password' })).toBeNull()
    expect(passwordField().placeholder).not.toBe('Saved password')
    expect(screen.getByText('Modified')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:saveServer')).toHaveLength(1))
    expect(savePayload(0)).toMatchObject({ id: 1, password: '' })
    // 비밀번호가 저장되지 않은 서버에는 지울 것이 없다.
    expect(screen.queryByRole('button', { name: 'Remove saved password' })).toBeNull()
  })

  it('warns near the password when saved passwords are only obscured or stored as plain text', async () => {
    // covers: Test-727
    const warnings = /only obscured|plain text/
    const cases: Array<[PasswordProtection['level'], RegExp | null]> = [
      ['basic', /No system keyring: saved passwords are only obscured, not protected\./],
      ['none', /Saved passwords are stored as plain text on this computer\./],
      ['keyring', null]
    ]
    for (const [level, text] of cases) {
      protection = level
      mockInvoke.mockClear()
      const { unmount } = render(
        <ServerManagerDialog initial={toDraft(LOCKED)} onClose={vi.fn()} />
      )
      await waitFor(() =>
        expect(invokeCalls(mockInvoke, 'ftp:getPasswordProtection')).toHaveLength(1)
      )
      if (text) {
        const dialog = screen.getByRole('dialog')
        expect(await within(dialog).findByText(text)).toBeTruthy()
        expect(within(dialog).getAllByText(warnings)).toHaveLength(1)
      } else {
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(screen.queryByText(warnings)).toBeNull()
      }
      unmount()
    }

    // 묻지 못하면 아무것도 보이지 않는다.
    mockInvoke.mockClear()
    mockInvoke.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'ftp:getPasswordProtection'
          ? { success: false, error: 'boom' }
          : { success: true, data: [] }
      )
    )
    render(<ServerManagerDialog initial={toDraft(LOCKED)} onClose={vi.fn()} />)
    await waitFor(() =>
      expect(invokeCalls(mockInvoke, 'ftp:getPasswordProtection')).toHaveLength(1)
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText(warnings)).toBeNull()
  })
})
