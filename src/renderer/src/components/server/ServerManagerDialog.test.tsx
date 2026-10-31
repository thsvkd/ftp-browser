/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useServerStore } from '@renderer/stores/useServerStore'
import { emptyDraft, toDraft } from '@renderer/lib/serverAddress'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import { ErrorCode } from '@shared/types/ipc'
import type {
  FtpConnectPayload,
  FtpServer,
  FtpServerInput,
  PasswordProtection
} from '@shared/types/ftp'
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

  const MOVED_HINT = 'Enter the password again for the new address, or remove it.'

  it('asks for the password again before moving a saved server to another address', async () => {
    // covers: Test-742
    const user = userEvent.setup()
    const { unmount } = render(<ServerManagerDialog initial={toDraft(LOCKED)} onClose={vi.fn()} />)
    const host = (): HTMLInputElement => screen.getByLabelText('Host') as HTMLInputElement

    // 별칭·사용자·FTPS, 대소문자만 바뀐 호스트는 같은 주소다: 저장된 비밀번호를 그대로 쓴다
    await user.type(screen.getByLabelText(/^Name/), ' 2')
    await user.type(screen.getByLabelText('Username'), 'x')
    await user.click(screen.getByRole('switch'))
    await user.clear(host())
    await user.type(host(), 'NAS.Local')
    expect(screen.queryByText(MOVED_HINT)).toBeNull()

    // 다른 호스트: 비밀번호 칸 아래에 알리고, 저장도 연결도 하지 않는다
    await user.clear(host())
    await user.type(host(), 'moved.local')
    expect(screen.getByText(MOVED_HINT)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toContain(MOVED_HINT)
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(invokeCalls(mockInvoke, 'ftp:saveServer')).toHaveLength(0)
    expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(0)

    // 비밀번호를 다시 입력하면 그 비밀번호로 옮긴다
    await user.type(passwordField(), 'new-pw')
    expect(screen.queryByText(MOVED_HINT)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:saveServer')).toHaveLength(1))
    expect(savePayload(0)).toMatchObject({ id: 1, host: 'moved.local', password: 'new-pw' })
    unmount()

    // 다른 포트: 저장된 비밀번호를 지우면 비밀번호 없이 옮긴다
    render(<ServerManagerDialog initial={toDraft(LOCKED)} onClose={vi.fn()} />)
    await user.clear(screen.getByLabelText('Port'))
    await user.type(screen.getByLabelText('Port'), '2121')
    expect(screen.getByText(MOVED_HINT)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Remove saved password' }))
    expect(screen.queryByText(MOVED_HINT)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:saveServer')).toHaveLength(2))
    expect(savePayload(1)).toMatchObject({ id: 1, port: 2121, password: '' })
  })

  it('explains in the current language when main refuses to move a saved password', async () => {
    // covers: Test-743
    const fallback = mockInvoke.getMockImplementation()!
    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) =>
      channel === 'ftp:saveServer'
        ? Promise.resolve({
            success: false,
            error: 'refused by main',
            code: ErrorCode.SAVED_PASSWORD_ADDRESS_CHANGED
          })
        : fallback(channel, ...args)
    )
    const user = userEvent.setup()
    render(<ServerManagerDialog initial={toDraft(LOCKED)} onClose={vi.fn()} />)

    // 렌더러가 아는 주소는 그대로지만(예: 목록이 오래됨) main이 거절한다
    await user.type(screen.getByLabelText(/^Name/), ' 2')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(MOVED_HINT)
    expect(alert.textContent).not.toContain('refused by main')
    expect(invokeCalls(mockInvoke, 'ftp:saveServer')).toHaveLength(1)
  })
})

describe('ServerManagerDialog — recent folders', () => {
  it("asks the recent folders of the selected server's own account key", async () => {
    // covers: Test-1153
    saved = [LOCKED]
    useServerStore.setState({ servers: [LOCKED] })
    const { unmount } = render(<ServerManagerDialog initial={toDraft(LOCKED)} onClose={vi.fn()} />)
    await waitFor(() =>
      expect(invokeCalls(mockInvoke, 'ftp:getRecentPaths')).toEqual([['me@nas.local:21']])
    )
    unmount()

    // 사용자 이름이 빈 저장 서버는 익명 키로 묻는다
    mockInvoke.mockClear()
    saved = [NAS]
    useServerStore.setState({ servers: [NAS] })
    render(<ServerManagerDialog initial={toDraft(NAS)} onClose={vi.fn()} />)
    await waitFor(() =>
      expect(invokeCalls(mockInvoke, 'ftp:getRecentPaths')).toEqual([['anonymous@nas.local:21']])
    )
  })
})

describe('ServerManagerDialog — activation on double-click', () => {
  /** 아이디는 있고 저장된 비밀번호는 없는 서버. */
  const BOB: FtpServer = {
    ...NAS,
    id: 2,
    name: 'Bob',
    host: 'bob.local',
    username: 'bob',
    hasPassword: false
  }
  const passwordField = (): HTMLInputElement =>
    screen.getByLabelText('Password', { selector: 'input' }) as HTMLInputElement
  /** ftp:connect까지 이르는 비동기 흐름(마이크로태스크·타이머)을 모두 비운다. */
  const drain = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  beforeEach(() => {
    // 이 파일의 기본 목은 ftp:list를 답하지 않는다. 연결이 성공하면 시작 폴더를 읽으러 가므로,
    // 성공 케이스가 목록 응답 없이 크래시하지 않도록 답을 둔다.
    const fallback = mockInvoke.getMockImplementation()!
    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) =>
      channel === 'ftp:list'
        ? Promise.resolve({ success: true, data: { path: args[0], entries: [] } })
        : fallback(channel, ...args)
    )
  })

  it('focuses the password inside the dialog instead of connecting a username-only server', async () => {
    // covers: Test-1222
    useServerStore.setState({ servers: [BOB] })
    const user = userEvent.setup()
    // 함정 A: 문서 앞의 툴바 비밀번호 칸이 포커스를 가로채면 안 된다.
    render(
      <>
        <input type="password" aria-label="toolbar password" />
        <ServerManagerDialog initial={toDraft(BOB)} onClose={vi.fn()} />
      </>
    )

    await user.dblClick(within(screen.getByRole('listbox')).getByText('Bob'))
    await drain()

    expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(0)
    await waitFor(() => expect(document.activeElement).toBe(passwordField()))
    expect(document.activeElement).not.toBe(screen.getByLabelText('toolbar password'))
  })

  it('closes the dialog only when the double-click starts a connect that succeeds', async () => {
    // covers: Test-1223
    const user = userEvent.setup()
    const closed = vi.fn()
    const first = render(<ServerManagerDialog initial={toDraft(NAS)} onClose={closed} />)

    await user.dblClick(within(screen.getByRole('listbox')).getByText('Home NAS'))
    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(1))
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1))
    first.unmount()

    // 연결에 실패하면 닫지 않는다(Promise<boolean> 계약).
    const fallback = mockInvoke.getMockImplementation()!
    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) =>
      channel === 'ftp:connect'
        ? Promise.resolve({ success: false, error: 'Authentication failed.' })
        : fallback(channel, ...args)
    )
    mockInvoke.mockClear()
    const keptOpen = vi.fn()
    render(<ServerManagerDialog initial={toDraft(NAS)} onClose={keptOpen} />)

    await user.dblClick(within(screen.getByRole('listbox')).getByText('Home NAS'))
    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(1))
    await drain()
    expect(keptOpen).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('ServerManagerDialog — anonymous login', () => {
  /** 사용자 이름이 있는 두 번째 저장 서버(저장된 비밀번호 없음). */
  const ME: FtpServer = { ...NAS, id: 3, name: 'Me', host: 'me.local', username: 'me' }
  const anonymousBox = (): HTMLInputElement =>
    screen.getByRole('checkbox', { name: 'Log in anonymously' }) as HTMLInputElement
  const userField = (): HTMLInputElement => screen.getByLabelText('Username') as HTMLInputElement
  const passwordField = (): HTMLInputElement =>
    screen.getByLabelText('Password', { selector: 'input' }) as HTMLInputElement
  const hostField = (): HTMLInputElement => screen.getByLabelText('Host') as HTMLInputElement

  it('opens checked for a server without a username and for a new server, unchecked for one with a username', async () => {
    // covers: Test-1309
    saved = [NAS, ME]
    useServerStore.setState({ servers: [NAS, ME] })
    const user = userEvent.setup()
    render(<ServerManagerDialog initial={toDraft(NAS)} onClose={vi.fn()} />)

    expect(anonymousBox().checked).toBe(true)
    expect(userField().disabled).toBe(true)
    expect(passwordField().disabled).toBe(true)

    await user.click(within(screen.getByRole('listbox')).getByText('Me'))
    expect(anonymousBox().checked).toBe(false)
    expect(userField().disabled).toBe(false)
    expect(passwordField().disabled).toBe(false)
    expect(userField().value).toBe('me')

    await user.click(screen.getByRole('button', { name: 'New server' }))
    expect(anonymousBox().checked).toBe(true)
    expect(userField().disabled).toBe(true)
    expect(passwordField().disabled).toBe(true)
  })

  it('clears the login and drops the saved password when checked, and saves it that way', async () => {
    // covers: Test-1310
    saved = [LOCKED]
    useServerStore.setState({ servers: [LOCKED] })
    const user = userEvent.setup()
    render(<ServerManagerDialog initial={toDraft(LOCKED)} onClose={vi.fn()} />)
    expect(anonymousBox().checked).toBe(false)
    expect(screen.getByRole('button', { name: 'Remove saved password' })).toBeTruthy()

    await user.click(anonymousBox())

    expect(anonymousBox().checked).toBe(true)
    expect(userField().value).toBe('')
    expect(userField().disabled).toBe(true)
    expect(passwordField().disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Remove saved password' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:saveServer')).toHaveLength(1))
    const payload = invokeCalls(mockInvoke, 'ftp:saveServer')[0][0] as FtpServerInput
    expect(payload).toMatchObject({ id: 1, username: '', password: '' })
  })

  it('restores the login typed before checking when unchecked, and focuses the username', async () => {
    // covers: Test-1311
    saved = [LOCKED]
    useServerStore.setState({ servers: [LOCKED] })
    const user = userEvent.setup()
    render(<ServerManagerDialog initial={toDraft(LOCKED)} onClose={vi.fn()} />)

    await user.type(passwordField(), 'pw')
    await user.click(anonymousBox())
    expect(userField().value).toBe('')
    expect(passwordField().value).toBe('')

    await user.click(anonymousBox())

    expect(anonymousBox().checked).toBe(false)
    expect(userField().value).toBe('me')
    expect(passwordField().value).toBe('pw')
    expect(passwordField().placeholder).toBe('Saved password')
    expect(screen.getByRole('button', { name: 'Remove saved password' })).toBeTruthy()
    expect(userField().disabled).toBe(false)
    expect(document.activeElement).toBe(userField())
  })

  it('unchecking a new server form enables an empty username and focuses it', async () => {
    // covers: Test-1312
    const user = userEvent.setup()
    render(<ServerManagerDialog initial={emptyDraft()} onClose={vi.fn()} />)
    expect(anonymousBox().checked).toBe(true)

    await user.click(anonymousBox())

    expect(anonymousBox().checked).toBe(false)
    expect(userField().disabled).toBe(false)
    expect(userField().value).toBe('')
    expect(document.activeElement).toBe(userField())
  })

  it('unchecks when a pasted address names a user, and stays checked for anonymous', () => {
    // covers: Test-1313
    const { unmount } = render(<ServerManagerDialog initial={emptyDraft()} onClose={vi.fn()} />)
    expect(anonymousBox().checked).toBe(true)

    fireEvent.paste(hostField(), { clipboardData: { getData: () => 'bob@nas.local:2121' } })

    expect(anonymousBox().checked).toBe(false)
    expect(userField().disabled).toBe(false)
    expect(userField().value).toBe('bob')
    unmount()

    render(<ServerManagerDialog initial={emptyDraft()} onClose={vi.fn()} />)
    fireEvent.paste(hostField(), { clipboardData: { getData: () => 'anonymous@nas.local:2121' } })

    expect(hostField().value).toBe('nas.local')
    expect(anonymousBox().checked).toBe(true)
    expect(userField().disabled).toBe(true)
  })

  it('connects anonymously after checking on a server with a username', async () => {
    // covers: Test-1314
    saved = [LOCKED]
    useServerStore.setState({ servers: [LOCKED] })
    const fallback = mockInvoke.getMockImplementation()!
    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) =>
      channel === 'ftp:list'
        ? Promise.resolve({ success: true, data: { path: args[1], entries: [] } })
        : fallback(channel, ...args)
    )
    const user = userEvent.setup()
    render(<ServerManagerDialog initial={toDraft(LOCKED)} onClose={vi.fn()} />)

    await user.click(anonymousBox())
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(1))
    const payload = invokeCalls(mockInvoke, 'ftp:connect')[0][0] as FtpConnectPayload
    expect(payload).toMatchObject({ user: 'anonymous', password: 'anonymous@' })
    expect(payload).not.toHaveProperty('savedPasswordOf')
  })

  it('does not bring back a saved password that saving as anonymous removed', async () => {
    // covers: Test-1315
    saved = [LOCKED]
    useServerStore.setState({ servers: [LOCKED] })
    const fallback = mockInvoke.getMockImplementation()!
    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel !== 'ftp:saveServer') return fallback(channel, ...args)
      // main처럼 저장 결과를 목록에 반영한다: 이제 저장 비밀번호가 없다.
      const row = savedFrom(args[0] as FtpServerInput)
      saved = [row]
      return Promise.resolve({ success: true, data: row })
    })
    const user = userEvent.setup()
    render(<ServerManagerDialog initial={toDraft(LOCKED)} onClose={vi.fn()} />)

    await user.click(anonymousBox())
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(useServerStore.getState().servers[0].hasPassword).toBe(false))

    await user.click(anonymousBox())

    expect(anonymousBox().checked).toBe(false)
    expect(userField().value).toBe('me')
    expect(screen.queryByRole('button', { name: 'Remove saved password' })).toBeNull()
    expect(passwordField().placeholder).not.toBe('Saved password')
  })

  it('resets the box when the same server or the new server form is picked again', async () => {
    // covers: Test-1391
    saved = [LOCKED]
    useServerStore.setState({ servers: [LOCKED] })
    const user = userEvent.setup()
    render(<ServerManagerDialog initial={toDraft(LOCKED)} onClose={vi.fn()} />)

    await user.click(anonymousBox())
    await user.click(within(screen.getByRole('listbox')).getByText('Home NAS'))
    expect(anonymousBox().checked).toBe(false)
    expect(userField().value).toBe('me')
    expect(userField().disabled).toBe(false)
    expect(passwordField().placeholder).toBe('Saved password')

    await user.click(screen.getByRole('button', { name: 'New server' }))
    await user.click(anonymousBox())
    await user.type(userField(), 'bob')
    await user.click(screen.getByRole('button', { name: 'New server' }))
    expect(anonymousBox().checked).toBe(true)
    expect(userField().value).toBe('')
    expect(userField().disabled).toBe(true)
  })

  it('keeps the login typed in the host field when the box is clicked right after', async () => {
    // covers: Test-1392
    const user = userEvent.setup()
    const { unmount } = render(<ServerManagerDialog initial={emptyDraft()} onClose={vi.fn()} />)
    // 적고 떠나면 체크가 풀린다
    await user.type(hostField(), 'bob@nas.local')
    await user.tab()
    expect(anonymousBox().checked).toBe(false)
    expect(userField().value).toBe('bob')
    unmount()

    // 적고 곧바로 체크박스를 누르면: 호스트 칸을 떠나며 풀린 체크가 그 클릭으로 다시 켜지지 않는다
    render(<ServerManagerDialog initial={emptyDraft()} onClose={vi.fn()} />)
    await user.type(hostField(), 'carol@nas.local')
    await user.click(anonymousBox())
    expect(anonymousBox().checked).toBe(false)
    expect(userField().value).toBe('carol')
    expect(userField().disabled).toBe(false)
    expect(document.activeElement).toBe(userField())
  })

  it('splits an address with a login before Enter connects, so the box matches the login', async () => {
    // covers: Test-1393
    const fallback = mockInvoke.getMockImplementation()!
    mockInvoke.mockImplementation((channel: string, ...args: unknown[]) =>
      channel === 'ftp:connect'
        ? Promise.resolve({ success: false, error: 'Authentication failed.' })
        : fallback(channel, ...args)
    )
    const user = userEvent.setup()
    render(<ServerManagerDialog initial={emptyDraft()} onClose={vi.fn()} />)
    expect(anonymousBox().checked).toBe(true)

    await user.type(hostField(), 'bob:secret@files.example{Enter}')

    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(1))
    const payload = invokeCalls(mockInvoke, 'ftp:connect')[0][0] as FtpConnectPayload
    expect(payload).toMatchObject({ user: 'bob', password: 'secret' })
    expect(anonymousBox().checked).toBe(false)
    expect(userField().value).toBe('bob')
  })

  it('unchecks when a pasted anonymous address carries a password', () => {
    // covers: Test-1394
    render(<ServerManagerDialog initial={emptyDraft()} onClose={vi.fn()} />)

    fireEvent.paste(hostField(), {
      clipboardData: { getData: () => 'anonymous:me@example.com@nas.local' }
    })

    expect(anonymousBox().checked).toBe(false)
    expect(userField().value).toBe('anonymous')
    expect(passwordField().value).toBe('me@example.com')
    expect(userField().disabled).toBe(false)
    expect(passwordField().disabled).toBe(false)
  })

  it('opens unchecked for a server without a username that has a saved password', () => {
    // covers: Test-1395
    const LEGACY: FtpServer = { ...NAS, hasPassword: true }
    saved = [LEGACY]
    useServerStore.setState({ servers: [LEGACY] })
    render(<ServerManagerDialog initial={toDraft(LEGACY)} onClose={vi.fn()} />)

    expect(anonymousBox().checked).toBe(false)
    expect(passwordField().disabled).toBe(false)
    expect(passwordField().placeholder).toBe('Saved password')
    expect(screen.getByRole('button', { name: 'Remove saved password' })).toBeTruthy()
  })
})
