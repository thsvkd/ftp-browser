/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { emptyDraft } from '@renderer/lib/serverAddress'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import { Toolbar } from '@renderer/components/layout/Toolbar'
import { ConfirmDialog } from '@renderer/components/common/ConfirmDialog'
import type { FtpServer } from '@shared/types/ftp'
import { ErrorCode } from '@shared/types/ipc'
import { NotConnectedPane } from './NotConnectedPane'

const mockInvoke = vi.fn()

const NAS: FtpServer = {
  id: 1,
  name: 'Home NAS',
  host: 'nas.local',
  port: 21,
  username: '',
  hasPassword: false,
  secure: false
}

/** Default IPC answers; `overrides` replaces single channels. */
function mockIpc(
  servers: FtpServer[] = [],
  overrides: Record<string, (...args: unknown[]) => unknown> = {}
): void {
  mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
    if (overrides[channel]) return overrides[channel](...args)
    if (channel === 'ftp:getRecentServers') return Promise.resolve({ success: true, data: servers })
    if (channel === 'ftp:getRecentPaths') return Promise.resolve({ success: true, data: [] })
    if (channel === 'ftp:getPasswordProtection') {
      return Promise.resolve({ success: true, data: { level: 'keyring' } })
    }
    if (channel === 'ftp:list') {
      return Promise.resolve({ success: true, data: { path: '/', entries: [] } })
    }
    return Promise.resolve({ success: true, data: undefined })
  })
}

function renderToolbar(withPane = false): void {
  render(
    <>
      <Toolbar onSettingsClick={() => undefined} />
      {withPane && <NotConnectedPane />}
      <ConfirmDialog />
    </>
  )
}

const addressInput = (): HTMLInputElement =>
  screen.getByRole('textbox', { name: 'Server address' }) as HTMLInputElement

beforeEach(() => {
  vi.clearAllMocks()
  mockIpc()
  vi.stubGlobal('api', makeApiMock(mockInvoke))
  useServerStore.setState({
    servers: [],
    draft: emptyDraft(),
    address: '',
    connecting: false,
    error: ''
  })
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

describe('ConnectBar — connecting', () => {
  it('aborts the in-flight connect when Cancel is clicked', async () => {
    let resolveConnect: ((value: { success: true; data: undefined }) => void) | undefined
    mockIpc([], {
      'ftp:connect': () =>
        new Promise((resolve) => {
          resolveConnect = resolve
        })
    })
    const user = userEvent.setup()
    renderToolbar()

    await user.type(addressInput(), 'ftp.example.com')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(invokeCalls(mockInvoke, 'ftp:disconnect')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()

    resolveConnect!({ success: true, data: undefined })
    await waitFor(() => {
      expect(useFtpStore.getState().host).toBe('')
      expect(useFtpStore.getState().connectionStatus).toBe('disconnected')
    })
    expect(invokeCalls(mockInvoke, 'ftp:list')).toHaveLength(0)
  })

  it('shows a failed connect as a note under the bar', async () => {
    mockIpc([], {
      'ftp:connect': () => Promise.resolve({ success: false, error: 'Authentication failed.' })
    })
    const user = userEvent.setup()
    renderToolbar()

    await user.type(addressInput(), 'me@nas.local{Enter}')

    expect((await screen.findByRole('alert')).textContent).toContain('Authentication failed.')
  })
})

describe('ConnectBar — saved servers', () => {
  it('labels a server by its alias and connects on double-click, keeping the alias', async () => {
    mockIpc([
      {
        id: 1,
        name: 'Galaxy S24',
        host: '192.168.0.7',
        port: 2221,
        username: 'phone',
        hasPassword: true,
        secure: false,
        maxTransfers: 6
      }
    ])
    const user = userEvent.setup()
    renderToolbar()

    await user.click(await screen.findByRole('button', { name: /Galaxy S24/ }))
    const list = screen.getByRole('listbox', { name: 'Saved servers' })
    expect(within(list).getByText('phone@192.168.0.7:2221')).toBeTruthy()
    await user.dblClick(within(list).getByText('Galaxy S24'))

    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(1))
    expect(invokeCalls(mockInvoke, 'ftp:connect')[0][0]).toEqual({
      id: 1,
      name: 'Galaxy S24',
      host: '192.168.0.7',
      port: 2221,
      user: 'phone',
      // 저장된 비밀번호는 렌더러가 모른다. main이 그 서버의 것을 읽어 로그인한다.
      savedPasswordOf: 1,
      secure: false,
      maxTransfers: 6
    })
  })

  it('connects a quick-connect address with 16 transfer connections', async () => {
    const user = userEvent.setup()
    renderToolbar()

    await user.type(addressInput(), 'files.example.com')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(1))
    expect(invokeCalls(mockInvoke, 'ftp:connect')[0][0]).toMatchObject({
      host: 'files.example.com',
      maxTransfers: 16
    })
  })

  it('drops the selected server alias once the address is edited to another host', async () => {
    mockIpc([NAS])
    const user = userEvent.setup()
    renderToolbar()

    await screen.findByRole('button', { name: /Home NAS/ })
    await user.type(addressInput(), 'x')

    expect(screen.queryByRole('button', { name: /Home NAS/ })).toBeNull()
    expect(screen.getByRole('button', { name: /New server/ })).toBeTruthy()
  })

  it('selects the saved server again when the address matches it', async () => {
    mockIpc([NAS])
    const user = userEvent.setup()
    renderToolbar()

    await screen.findByRole('button', { name: /Home NAS/ })
    await user.clear(addressInput())
    await user.type(addressInput(), 'nas.local')

    expect(screen.getByRole('button', { name: /Home NAS/ })).toBeTruthy()
  })

  it('opens the server manager on the server whose Edit was clicked', async () => {
    mockIpc([NAS, { ...NAS, id: 2, name: 'Phone', host: 'phone.local' }])
    const user = userEvent.setup()
    renderToolbar()

    await user.click(await screen.findByRole('button', { name: /Home NAS/ }))
    await user.click(screen.getByRole('button', { name: 'Edit Home NAS' }))

    const dialog = screen.getByRole('dialog', { name: 'Server manager' })
    expect(within(dialog).getByDisplayValue('Home NAS')).toBeTruthy()
    expect(within(dialog).getByDisplayValue('nas.local')).toBeTruthy()
    // 드롭다운은 닫혀 있다
    expect(screen.queryByRole('textbox', { name: 'Search saved servers' })).toBeNull()
  })
})

describe('ServerManagerDialog', () => {
  it('saves without connecting', async () => {
    mockIpc([NAS], {
      'ftp:saveServer': (server) =>
        Promise.resolve({ success: true, data: { ...(server as FtpServer), id: 1 } })
    })
    const user = userEvent.setup()
    renderToolbar()

    await screen.findByRole('button', { name: /Home NAS/ })
    await user.click(screen.getByRole('button', { name: 'Server manager' }))
    const dialog = screen.getByRole('dialog', { name: 'Server manager' })
    const alias = within(dialog).getByDisplayValue('Home NAS')
    await user.clear(alias)
    await user.type(alias, 'Living room')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:saveServer')).toHaveLength(1))
    expect(invokeCalls(mockInvoke, 'ftp:saveServer')[0][0]).toMatchObject({
      id: 1,
      name: 'Living room',
      host: 'nas.local',
      port: 21
    })
    expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(0)
  })

  it('asks with the in-app confirm before deleting', async () => {
    mockIpc([NAS])
    const user = userEvent.setup()
    renderToolbar()

    await screen.findByRole('button', { name: /Home NAS/ })
    await user.click(screen.getByRole('button', { name: 'Server manager' }))
    const dialog = screen.getByRole('dialog', { name: 'Server manager' })
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    const confirm = await screen.findByRole('alertdialog')
    expect(confirm.textContent).toContain('Delete "Home NAS"?')
    expect(invokeCalls(mockInvoke, 'ftp:deleteServer')).toHaveLength(0)
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:deleteServer')).toEqual([[1]]))
    expect(within(dialog).queryByText('Home NAS')).toBeNull()
  })

  it('closes without aborting anything when no connect is in flight', async () => {
    const user = userEvent.setup()
    renderToolbar()

    await user.click(screen.getByRole('button', { name: 'Server manager' }))
    await user.click(
      within(screen.getByRole('dialog', { name: 'Server manager' })).getByRole('button', {
        name: 'Close'
      })
    )

    expect(screen.queryByRole('dialog', { name: 'Server manager' })).toBeNull()
    expect(invokeCalls(mockInvoke, 'ftp:disconnect')).toHaveLength(0)
  })
})

const ALICE: FtpServer = { ...NAS, username: 'alice', hasPassword: true }
const PHONE: FtpServer = { ...NAS, id: 2, name: 'Phone', host: 'phone.local' }
const connectPayload = (): unknown => invokeCalls(mockInvoke, 'ftp:connect')[0]?.[0]
const savedButton = (): Promise<HTMLElement> =>
  screen.findByRole('button', { name: /Home NAS/, expanded: false })

/** Replaces the address, presses Enter and waits for the connect call. */
async function connectWith(
  user: ReturnType<typeof userEvent.setup>,
  address: string
): Promise<void> {
  await user.clear(addressInput())
  await user.type(addressInput(), `${address}{Enter}`)
  await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(1))
}

describe('regressions — address and saved accounts', () => {
  it('does not send the saved password for another user typed in the address (M4)', async () => {
    mockIpc([ALICE])
    const user = userEvent.setup()
    renderToolbar()
    await savedButton()

    await connectWith(user, 'bob@nas.local')

    expect(connectPayload()).toMatchObject({ user: 'bob', password: 'anonymous@' })
    // id 없이 보내야 main이 저장된 alice 계정을 덮어쓰지 않는다(N1)
    expect(connectPayload()).not.toHaveProperty('id')
    expect(connectPayload()).not.toHaveProperty('savedPasswordOf')
  })

  it('keeps the saved account without user@, and goes anonymous with anonymous@ (M4)', async () => {
    mockIpc([ALICE])
    const user = userEvent.setup()
    renderToolbar()
    await savedButton()

    await connectWith(user, 'nas.local')
    expect(connectPayload()).toMatchObject({
      id: 1,
      user: 'alice',
      savedPasswordOf: 1,
      name: 'Home NAS'
    })
    expect(connectPayload()).not.toHaveProperty('password')

    mockInvoke.mockClear()
    await connectWith(user, 'anonymous@nas.local')
    expect(connectPayload()).toMatchObject({ user: 'anonymous', password: 'anonymous@' })
    expect(connectPayload()).not.toHaveProperty('id')
    expect(connectPayload()).not.toHaveProperty('savedPasswordOf')
  })

  it('matches an older saved row case-insensitively and keeps its stored host (M3)', async () => {
    mockIpc([{ ...ALICE, host: 'NAS.local' }])
    const user = userEvent.setup()
    renderToolbar()
    await savedButton()

    await connectWith(user, 'nas.local')

    expect(connectPayload()).toMatchObject({ host: 'NAS.local', name: 'Home NAS' })
  })

  it('moves a password typed into the address into the password field', async () => {
    const user = userEvent.setup()
    renderToolbar()

    await user.type(addressInput(), 'me:secret@nas.local')

    expect(addressInput().value).toBe('me@nas.local')
    expect((screen.getByPlaceholderText('Password') as HTMLInputElement).value).toBe('secret')
  })
})

describe('saved password — toolbar', () => {
  const draft = (): ReturnType<typeof useServerStore.getState>['draft'] =>
    useServerStore.getState().draft
  // 툴바의 비밀번호 칸은 저장된 비밀번호를 쓰는 동안 이름이 "Saved password"다(E20)
  const passwordField = (): HTMLInputElement =>
    screen.getByLabelText(/^(Saved password|Password)$/, { selector: 'input' }) as HTMLInputElement

  it('carries the saved password only to the saved account, never to a typed one', () => {
    // covers: Test-721
    useServerStore.setState({ servers: [ALICE] })
    const { setAddress } = useServerStore.getState()

    setAddress('nas.local')
    expect(draft()).toMatchObject({ id: 1, username: 'alice', password: '', savedPassword: true })
    setAddress('alice@nas.local')
    expect(draft()).toMatchObject({ username: 'alice', savedPassword: true })

    // 다른 사용자에게는 저장된 비밀번호를 넘기지 않는다. 지우면 저장된 계정으로 돌아간다.
    setAddress('bob@nas.local')
    expect(draft()).toMatchObject({ username: 'bob', password: '', savedPassword: false })
    setAddress('nas.local')
    expect(draft()).toMatchObject({ username: 'alice', password: '', savedPassword: true })

    // 주소에 적은 비밀번호가 저장된 것을 대신한다.
    setAddress('alice:typed@nas.local')
    expect(draft()).toMatchObject({ username: 'alice', password: 'typed', savedPassword: false })

    // 저장된 서버에서 벗어나면 끌고 가지 않는다.
    useServerStore.setState({ draft: emptyDraft() })
    setAddress('nas.local')
    setAddress('nas.local:2121')
    expect(draft()).toMatchObject({ host: 'nas.local', port: '2121', savedPassword: false })
    expect(draft().id).toBeUndefined()
  })

  it('logs in with the saved password by server id, or with the typed one instead', async () => {
    // covers: Test-722
    mockIpc([ALICE])
    const user = userEvent.setup()
    renderToolbar()
    await savedButton()

    await user.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(1))
    expect(connectPayload()).toMatchObject({ id: 1, user: 'alice', savedPasswordOf: 1 })
    expect(connectPayload()).not.toHaveProperty('password')
    await waitFor(() => expect(useServerStore.getState().connecting).toBe(false))

    mockInvoke.mockClear()
    await user.type(passwordField(), 'typed')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(1))
    expect(connectPayload()).toMatchObject({ id: 1, user: 'alice', password: 'typed' })
    expect(connectPayload()).not.toHaveProperty('savedPasswordOf')
  })

  it('shows a saved password as an empty field with a placeholder until one is typed', async () => {
    // covers: Test-724
    mockIpc([ALICE])
    const user = userEvent.setup()
    renderToolbar()
    await savedButton()

    expect(passwordField().value).toBe('')
    expect(passwordField().title).toBe('Saved password')
    await user.type(passwordField(), 'typed')
    expect(passwordField().value).toBe('typed')
    await user.clear(passwordField())

    await user.click(screen.getByRole('button', { name: 'Server manager' }))
    const dialog = screen.getByRole('dialog', { name: 'Server manager' })
    const field = within(dialog).getByLabelText('Password') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('Saved password')
    // 보기 버튼은 입력한 것만 보인다. 저장된 비밀번호는 렌더러에 없다.
    await user.click(within(dialog).getByRole('button', { name: 'Show password' }))
    expect(field.type).toBe('text')
    expect(field.value).toBe('')
    await user.type(field, 'new-pw')
    expect(field.value).toBe('new-pw')
  })

  it('stops offering the saved password once the toolbar server is deleted', async () => {
    // covers: Test-729
    mockIpc([ALICE])
    const user = userEvent.setup()
    renderToolbar()
    await savedButton()
    await user.click(screen.getByRole('button', { name: 'Server manager' }))
    const dialog = screen.getByRole('dialog', { name: 'Server manager' })

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    const confirm = await screen.findByRole('alertdialog')
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(draft().id).toBeUndefined())

    // 서버와 함께 그 비밀번호도 지워졌다. 저장 안 된 새 서버는 저장된 비밀번호를 쓰지 않는다.
    expect(draft()).toMatchObject({ username: 'alice', savedPassword: false })
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(passwordField().placeholder).toBe('Password')
    expect(passwordField().title).toBe('')
  })

  it('fits a language-neutral placeholder in the toolbar and names the field "Saved password"', async () => {
    // covers: Test-744
    mockIpc([ALICE, { ...NAS, id: 2, host: 'open.local', username: 'bob' }])
    const user = userEvent.setup()
    renderToolbar()
    await savedButton()

    // 좁은 툴바 칸에는 점만 두고, 현지화된 "저장된 비밀번호"는 이름·툴팁으로 알린다
    const field = screen.getByLabelText('Saved password', { selector: 'input' }) as HTMLInputElement
    expect(field.placeholder).toBe('••••••••')
    expect(field.title).toBe('Saved password')
    expect(field.value).toBe('')

    // 편집기는 넓으니 현지화된 자리표시를 그대로 둔다
    await user.click(screen.getByRole('button', { name: 'Server manager' }))
    const dialog = screen.getByRole('dialog', { name: 'Server manager' })
    expect((within(dialog).getByLabelText('Password') as HTMLInputElement).placeholder).toBe(
      'Saved password'
    )
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))

    try {
      act(() => useSettingsStore.setState({ language: 'de' }))
      const de = screen.getByLabelText('Gespeichertes Passwort', {
        selector: 'input'
      }) as HTMLInputElement
      expect(de).toBe(field)
      expect(de.placeholder).toBe('••••••••')
      expect(de.title).toBe('Gespeichertes Passwort')
    } finally {
      act(() => useSettingsStore.setState({ language: 'system' }))
    }

    // 저장된 비밀번호가 없는 서버는 예전처럼 "Password"
    act(() => useServerStore.getState().setAddress('bob@open.local'))
    const plain = (await screen.findByLabelText('Password', {
      selector: 'input'
    })) as HTMLInputElement
    expect(plain.placeholder).toBe('Password')
    expect(plain.title).toBe('')
  })

  it('asks to enter the password again when this computer cannot read the saved one', async () => {
    // covers: Test-726
    mockIpc([ALICE], {
      'ftp:connect': () =>
        Promise.resolve({
          success: false,
          error: 'Error while decrypting the ciphertext',
          code: ErrorCode.SAVED_PASSWORD_UNREADABLE
        })
    })
    const user = userEvent.setup()
    renderToolbar()
    await savedButton()

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(
      "The saved password can't be read on this computer. Enter it again."
    )
    expect(alert.textContent).not.toContain('decrypting')
    // 다른 것은 지우지 않는다: 툴바는 그대로 저장된 서버와 그 비밀번호를 가리킨다.
    expect(addressInput().value).toBe('alice@nas.local:21')
    expect(draft()).toMatchObject({ id: 1, username: 'alice', savedPassword: true })
    expect(passwordField().title).toBe('Saved password')
  })
})

describe('regressions — switching and connecting', () => {
  it('only closes the dropdown when the connected server is picked again (M2)', async () => {
    mockIpc([NAS])
    const user = userEvent.setup()
    renderToolbar()
    await savedButton()
    useFtpStore.setState({ connectionStatus: 'connected', host: 'nas.local' })

    await user.click(await screen.findByTitle('Switch server'))
    await user.click(within(screen.getByRole('listbox')).getByText('Home NAS'))

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(invokeCalls(mockInvoke, 'ftp:disconnect')).toHaveLength(0)
    expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(0)
  })

  it('ignores dropdown and chip clicks while a connect is in flight (L3)', async () => {
    mockIpc([NAS, PHONE], { 'ftp:connect': () => new Promise(() => undefined) })
    const user = userEvent.setup()
    renderToolbar(true)
    await savedButton()

    await user.click(screen.getByRole('button', { name: 'Connect' }))
    await screen.findByRole('button', { name: 'Cancel' })
    await user.click(screen.getByRole('button', { name: 'Phone' }))
    await user.click(await savedButton())
    await user.click(within(screen.getByRole('listbox')).getByText('Phone'))

    expect(useServerStore.getState().draft.id).toBe(1)
    expect(addressInput().value).toBe('nas.local:21')
    expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(1)
  })
})

describe('regressions — server manager connect', () => {
  async function openManagerAndEditHost(
    user: ReturnType<typeof userEvent.setup>,
    host: string
  ): Promise<HTMLElement> {
    await savedButton()
    await user.click(screen.getByRole('button', { name: 'Server manager' }))
    const dialog = screen.getByRole('dialog', { name: 'Server manager' })
    const hostInput = within(dialog).getByDisplayValue('nas.local')
    await user.clear(hostInput)
    await user.type(hostInput, host)
    return dialog
  }

  it('saves an edited server by id before connecting (H1)', async () => {
    mockIpc([NAS, PHONE], {
      'ftp:saveServer': (server) => Promise.resolve({ success: true, data: server })
    })
    const user = userEvent.setup()
    renderToolbar()
    const dialog = await openManagerAndEditHost(user, 'nas2.local')

    await user.click(within(dialog).getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(1))
    const channels = mockInvoke.mock.calls.map((c) => c[0])
    expect(channels.indexOf('ftp:saveServer')).toBeLessThan(channels.indexOf('ftp:connect'))
    expect(invokeCalls(mockInvoke, 'ftp:saveServer')[0][0]).toMatchObject({
      id: 1,
      host: 'nas2.local'
    })
  })

  it('does not connect when the edited address belongs to another saved server (H1)', async () => {
    mockIpc([NAS, PHONE], {
      'ftp:saveServer': () =>
        Promise.resolve({ success: false, error: 'exists', code: 'SERVER_EXISTS' })
    })
    const user = userEvent.setup()
    renderToolbar()
    const dialog = await openManagerAndEditHost(user, 'phone.local')

    await user.click(within(dialog).getByRole('button', { name: 'Connect' }))

    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'Another saved server already uses phone.local:21.'
    )
    expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(0)
  })

  it('refuses a new server on a saved address instead of overwriting it (M1)', async () => {
    mockIpc([NAS])
    const user = userEvent.setup()
    renderToolbar()
    await savedButton()
    await user.click(screen.getByRole('button', { name: 'Server manager' }))
    const dialog = screen.getByRole('dialog', { name: 'Server manager' })
    await user.click(within(dialog).getByRole('button', { name: 'New server' }))
    await user.type(within(dialog).getByPlaceholderText(/paste an ftp/), 'NAS.LOCAL')

    await user.click(within(dialog).getByRole('button', { name: 'Connect' }))

    expect((await within(dialog).findByRole('alert')).textContent).toContain('already uses')
    expect(invokeCalls(mockInvoke, 'ftp:connect')).toHaveLength(0)
    expect(invokeCalls(mockInvoke, 'ftp:saveServer')).toHaveLength(0)
  })

  it('tells unaliased servers on the same IP apart by port in the recent chips', async () => {
    mockIpc([
      { ...NAS, name: '', id: 1, host: '192.168.0.94', port: 8502 },
      { ...NAS, name: '', id: 2, host: '192.168.0.94', port: 2221 },
      { ...NAS, id: 3, name: 'Galaxy', host: '192.168.0.94', port: 2121 }
    ])
    renderToolbar(true)

    expect(await screen.findByRole('button', { name: /192\.168\.0\.94:8502/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /192\.168\.0\.94:2221/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Galaxy$/ })).toBeTruthy()
  })
})

describe('reconnecting — start folder', () => {
  const recent = (...paths: string[]): (() => Promise<unknown>) => {
    return () =>
      Promise.resolve({
        success: true,
        data: paths.map((path) => ({ path, lastVisited: '2026-09-29 10:00:00.000' }))
      })
  }
  const listedPaths = (): unknown[] => invokeCalls(mockInvoke, 'ftp:list').map((c) => c[0])

  it('opens the folder the server was last left in', async () => {
    mockIpc([NAS], { 'ftp:getRecentPaths': recent('/photos/2026', '/photos', '/') })
    const user = userEvent.setup()
    renderToolbar(true)

    await user.dblClick(await screen.findByTitle(/Double-click to connect/))

    await waitFor(() => expect(useFtpStore.getState().currentPath).toBe('/photos/2026'))
    expect(listedPaths()[0]).toBe('/photos/2026')
    expect(invokeCalls(mockInvoke, 'ftp:getRecentPaths')[0]).toEqual(['nas.local', 21])
  })

  it('starts at the root when the server has no recent folder', async () => {
    mockIpc([NAS])
    const user = userEvent.setup()
    renderToolbar(true)

    await user.dblClick(await screen.findByTitle(/Double-click to connect/))

    await waitFor(() => expect(listedPaths()).toEqual(['/']))
  })

  it('falls back to the root when the last folder is gone', async () => {
    mockIpc([NAS], {
      'ftp:getRecentPaths': recent('/gone'),
      'ftp:list': (path) =>
        Promise.resolve(
          path === '/gone'
            ? { success: false, error: 'No such directory' }
            : { success: true, data: { path, entries: [] } }
        )
    })
    const user = userEvent.setup()
    renderToolbar(true)

    await user.dblClick(await screen.findByTitle(/Double-click to connect/))

    await waitFor(() => expect(useFtpStore.getState().connectionStatus).not.toBe('error'))
    await waitFor(() => expect(listedPaths()).toEqual(['/gone', '/']))
    expect(useFtpStore.getState().currentPath).toBe('/')
  })

  it('opens a folder typed in the address instead of the last one', async () => {
    mockIpc([NAS], { 'ftp:getRecentPaths': recent('/photos') })
    const user = userEvent.setup()
    renderToolbar()
    await savedButton()

    await connectWith(user, 'nas.local/music')

    await waitFor(() => expect(listedPaths()[0]).toBe('/music'))
    expect(invokeCalls(mockInvoke, 'ftp:getRecentPaths')).toHaveLength(0)
  })

  it('resumes the last folder on a later reconnect after opening a typed one', async () => {
    mockIpc([NAS], { 'ftp:getRecentPaths': recent('/music/2026') })
    const user = userEvent.setup()
    renderToolbar()
    await savedButton()
    await connectWith(user, 'nas.local/music')
    await waitFor(() => expect(useServerStore.getState().connecting).toBe(false))
    mockInvoke.mockClear()

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(listedPaths()[0]).toBe('/music/2026'))
  })

  it('forgets a folder typed in the address once it is erased again', async () => {
    mockIpc([NAS], { 'ftp:getRecentPaths': recent('/photos') })
    const user = userEvent.setup()
    renderToolbar()
    await savedButton()
    await user.clear(addressInput())
    await user.type(addressInput(), 'nas.local/m')
    await user.type(addressInput(), '{Backspace}{Backspace}{Enter}')

    await waitFor(() => expect(listedPaths()[0]).toBe('/photos'))
  })

  it('opens the root when it is picked as the start folder in the server manager', async () => {
    mockIpc([NAS], { 'ftp:getRecentPaths': recent('/photos') })
    const user = userEvent.setup()
    renderToolbar()
    await savedButton()
    await user.click(screen.getByRole('button', { name: 'Server manager' }))
    const dialog = screen.getByRole('dialog', { name: 'Server manager' })

    await user.click(await within(dialog).findByRole('button', { name: '/' }))
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(listedPaths()[0]).toBe('/'))
    expect(invokeCalls(mockInvoke, 'ftp:getRecentPaths')).toHaveLength(1)
  })
})
