/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { formatBytes, formatDate } from '@renderer/lib/utils'
import type {
  TransferConflict,
  TransferSendRequest,
  TransferSendResult
} from '@shared/types/transfer'
import { ConflictSheet } from './ConflictSheet'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

const mockInvoke = vi.fn()

function conflict(name: string, overrides: Partial<TransferConflict> = {}): TransferConflict {
  return {
    target: `C:\\dl\\${name}`,
    source: `/photos/${name}`,
    name,
    incoming: { size: 2048, modifiedAt: '2024-05-02T10:00:00.000Z' },
    existing: { size: 1024, modifiedAt: '2024-05-01T10:00:00.000Z' },
    ...overrides
  }
}

/** 원격 쪽 연결 */
const K = 'me@nas.local:21'

const REQUEST: TransferSendRequest = {
  direction: 'download',
  sources: ['/photos'],
  destDir: 'C:\\dl'
}

const QUEUED: TransferSendResult = {
  batchId: 'b1',
  ids: ['j1'],
  skipped: [],
  conflicts: [],
  totalBytes: 0
}

/** 첫 `transfer:send`는 충돌을 돌려주고, 그다음부터는 큐에 넣었다고 답한다. */
function answerConflicts(conflicts: TransferConflict[]): void {
  let first = true
  mockInvoke.mockImplementation(async (channel: string) => {
    if (channel !== 'transfer:send') return { success: true }
    if (first) {
      first = false
      return { success: true, data: { ...QUEUED, batchId: undefined, ids: [], conflicts } }
    }
    return { success: true, data: QUEUED }
  })
}

/** 보내기를 시작하고 시트가 뜰 때까지 기다린다. async 함수가 프라미스를 풀지 않도록 감싸서 돌려준다. */
async function startSend(): Promise<{ pending: Promise<TransferSendResult | null> }> {
  let pending!: Promise<TransferSendResult | null>
  act(() => {
    pending = useTransferStore.getState().send(K, REQUEST, {
      label: 'photos',
      to: { side: 'local', path: 'C:\\dl' }
    })
  })
  await screen.findByRole('alertdialog')
  return { pending }
}

/** 라디오를 고르고 확인을 눌러 그 결정을 적용한다. */
async function decide(
  user: ReturnType<typeof userEvent.setup>,
  choice: string,
  within_: HTMLElement = screen.getByRole('alertdialog')
): Promise<void> {
  await user.click(within(within_).getByRole('radio', { name: choice }))
  await user.click(within(within_).getByRole('button', { name: 'Confirm' }))
}

function secondDecisions(): Record<string, string> | undefined {
  const sends = invokeCalls(mockInvoke, 'transfer:send')
  expect(sends).toHaveLength(2)
  expect(sends.map(([conn]) => conn)).toEqual([K, K])
  return (sends[1][1] as TransferSendRequest).decisions
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('api', makeApiMock(mockInvoke))
  // 카드의 로컬 썸네일이 IntersectionObserver를 쓴다. jsdom에는 없다.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe = (): void => undefined
      disconnect = (): void => undefined
    }
  )
  useTransferStore.setState({ jobs: [], conflictQueue: [], pendingSends: [], batchMeta: {} })
  useSettingsStore.setState({ conflictChoice: null })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ConflictSheet', () => {
  it('shows the first conflict as two cards with the newer badge, apply-to-rest on and the newer-only choice selected and focused; cancel sends nothing more', async () => {
    // covers: Test-812
    answerConflicts([conflict('a.jpg'), conflict('b.jpg'), conflict('c.jpg')])
    render(<ConflictSheet />)
    const { pending } = await startSend()

    const sheet = screen.getByRole('alertdialog')
    expect(within(sheet).getByText('"a.jpg" already exists')).toBeTruthy()
    expect(within(sheet).getByText(/Conflict 1 of 3/)).toBeTruthy()
    const existing = within(sheet).getByRole('group', { name: 'Already there' })
    const incoming = within(sheet).getByRole('group', { name: 'Being sent' })
    expect(within(existing).getByText(formatBytes(1024))).toBeTruthy()
    expect(within(existing).getByText(formatDate('2024-05-01T10:00:00.000Z'))).toBeTruthy()
    expect(within(incoming).getByText(formatBytes(2048))).toBeTruthy()
    expect(within(incoming).getByText('Newer')).toBeTruthy()
    expect(within(existing).queryByText('Newer')).toBeNull()
    const applyAll = within(sheet).getByRole('checkbox', {
      name: 'Do the same for the other 2'
    }) as HTMLInputElement
    expect(applyAll.checked).toBe(true)
    expect(document.activeElement).toBe(within(sheet).getByRole('radio', { name: 'Newer only' }))

    await userEvent.setup().click(within(sheet).getByRole('button', { name: 'Cancel' }))

    await expect(pending).resolves.toBeNull()
    expect(invokeCalls(mockInvoke, 'transfer:send')).toHaveLength(1)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('applies keep-both to every conflict when apply-to-rest is on, asks the next one when off, and Esc skips', async () => {
    // covers: Test-813
    const user = userEvent.setup()
    const three = [conflict('a.jpg'), conflict('b.jpg'), conflict('c.jpg')]
    answerConflicts(three)
    render(<ConflictSheet />)
    let { pending } = await startSend()

    await decide(user, 'Keep both (rename)')
    await pending
    expect(secondDecisions()).toEqual({
      'C:\\dl\\a.jpg': 'rename',
      'C:\\dl\\b.jpg': 'rename',
      'C:\\dl\\c.jpg': 'rename'
    })

    // 끄면 다음 충돌을 하나씩 묻는다.
    mockInvoke.mockClear()
    answerConflicts(three.slice(0, 2))
    ;({ pending } = await startSend())
    await user.click(screen.getByRole('checkbox', { name: 'Do the same for the other 1' }))
    await decide(user, 'Overwrite')
    expect(screen.getByText('"b.jpg" already exists')).toBeTruthy()
    expect(screen.getByText(/Conflict 2 of 2/)).toBeTruthy()
    expect(invokeCalls(mockInvoke, 'transfer:send')).toHaveLength(1)
    await decide(user, 'Skip')
    await pending
    expect(secondDecisions()).toEqual({ 'C:\\dl\\a.jpg': 'overwrite', 'C:\\dl\\b.jpg': 'skip' })

    // Esc는 건너뛰기: 켜져 있으면 모두 skip
    mockInvoke.mockClear()
    answerConflicts(three)
    ;({ pending } = await startSend())
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await pending
    expect(secondDecisions()).toEqual({
      'C:\\dl\\a.jpg': 'skip',
      'C:\\dl\\b.jpg': 'skip',
      'C:\\dl\\c.jpg': 'skip'
    })
  })

  it('sends newer as the decision and gives focus back to where the sheet opened from', async () => {
    // covers: Test-814
    answerConflicts([conflict('a.jpg'), conflict('b.jpg')])
    render(
      <>
        <button>opener</button>
        <ConflictSheet />
      </>
    )
    const opener = screen.getByRole('button', { name: 'opener' })
    opener.focus()
    const { pending } = await startSend()

    // 기본 선택이 더 최신 것만이라 확인만 누르면 된다.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Confirm' }))
    await pending

    expect(secondDecisions()).toEqual({ 'C:\\dl\\a.jpg': 'newer', 'C:\\dl\\b.jpg': 'newer' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(document.activeElement).toBe(opener)
  })

  it('shows both cards of a same-side prompt on that side and only keep-both or skip for a folder', async () => {
    // covers: Test-842
    mockInvoke.mockResolvedValue({ success: true })
    render(<ConflictSheet />)
    const moved = { target: '/dst/a.jpg', source: '/src/a.jpg', folder: false }
    let answer!: Promise<Record<string, string> | null>
    act(() => {
      answer = useTransferStore
        .getState()
        .askConflicts('move', [conflict('a.jpg', moved)], { server: K })
    })
    await screen.findByRole('alertdialog')
    // 원격 이동: 있던 것도 보내는 것도 그 연결의 원격 파일이다(원격 썸네일 요청 두 건).
    expect(
      invokeCalls(mockInvoke, 'thumbnail:request').map(([conn, r]) => [
        conn,
        (r as { remotePath: string }).remotePath
      ])
    ).toEqual([
      [K, '/dst/a.jpg'],
      [K, '/src/a.jpg']
    ])
    await decide(userEvent.setup(), 'Overwrite')
    await expect(answer).resolves.toEqual({ '/dst/a.jpg': 'overwrite' })

    act(() => {
      answer = useTransferStore
        .getState()
        .askConflicts('copy', [
          conflict('sub', { target: 'C:\\dst\\sub', source: 'C:\\src\\sub', folder: true })
        ])
    })
    const sheet = await screen.findByRole('alertdialog')
    expect(
      within(sheet)
        .getAllByRole('radio')
        .map((r) => (r as HTMLInputElement).labels?.[0].textContent)
    ).toEqual(['Keep both (rename)', 'Skip'])
    await decide(userEvent.setup(), 'Skip', sheet)
    await expect(answer).resolves.toEqual({ 'C:\\dst\\sub': 'skip' })
  })

  it('shows a relay conflict as two remote cards on their own servers and resends with the decisions', async () => {
    // covers: Test-1037
    const A = 'me@a.example:21'
    const B = 'you@b.example:2121'
    render(<ConflictSheet />)
    const thumbs = (): unknown[][] =>
      invokeCalls(mockInvoke, 'thumbnail:request').map(([conn, r]) => [
        conn,
        (r as { remotePath: string }).remotePath
      ])
    // 시트가 뜰 때까지 기다린다. 결정 전에는 끝나지 않는 보내기를 감싸서 돌려준다
    const ask = async (
      conn: string,
      request: TransferSendRequest,
      c: TransferConflict
    ): Promise<{ pending: Promise<TransferSendResult | null> }> => {
      answerConflicts([c])
      let pending!: Promise<TransferSendResult | null>
      act(() => {
        pending = useTransferStore.getState().send(conn, request, {
          label: 'a.jpg',
          to: { side: 'remote', path: '/photos', server: B }
        })
      })
      await screen.findByRole('alertdialog')
      return { pending }
    }

    const relay: TransferSendRequest = {
      direction: 'relay',
      sourceServer: A,
      sources: ['/photos'],
      destDir: '/photos'
    }
    const same = conflict('a.jpg', { target: '/photos/a.jpg', source: '/photos/a.jpg' })
    const { pending } = await ask(B, relay, same)
    // 있던 것은 받는 쪽(B), 보내는 것은 보내는 쪽(A)의 원격 파일이다. 로컬로 뒤집히지 않는다
    expect(thumbs()).toEqual([
      [B, '/photos/a.jpg'],
      [A, '/photos/a.jpg']
    ])
    await decide(userEvent.setup(), 'Overwrite')
    await expect(pending).resolves.toEqual(QUEUED)
    expect(invokeCalls(mockInvoke, 'transfer:send')).toEqual([
      [B, relay],
      [B, { ...relay, decisions: { '/photos/a.jpg': 'overwrite' } }]
    ])

    // 다운로드의 보내는 것과 업로드의 있던 것은 그 연결의 원격 파일이다
    mockInvoke.mockClear()
    await ask(A, REQUEST, conflict('a.jpg'))
    expect(thumbs()).toEqual([[A, '/photos/a.jpg']])
    await decide(userEvent.setup(), 'Skip')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    mockInvoke.mockClear()
    const upload: TransferSendRequest = {
      direction: 'upload',
      sources: ['C:\\pics\\a.jpg'],
      destDir: '/up'
    }
    await ask(B, upload, conflict('a.jpg', { target: '/up/a.jpg', source: 'C:\\pics\\a.jpg' }))
    expect(thumbs()).toEqual([[B, '/up/a.jpg']])
  })

  it('applies the selected choice on Confirm or Enter, nothing before, and Esc still skips', async () => {
    // covers: Test-1086
    const user = userEvent.setup()
    answerConflicts([conflict('a.jpg')])
    render(<ConflictSheet />)
    let { pending } = await startSend()
    const sheet = screen.getByRole('alertdialog')
    const radios = within(sheet).getAllByRole('radio') as HTMLInputElement[]
    expect(radios.map((r) => r.labels?.[0].textContent)).toEqual([
      'Keep both (rename)',
      'Overwrite',
      'Newer only',
      'Skip'
    ])
    expect(radios.map((r) => r.checked)).toEqual([false, false, true, false])
    // 라디오를 고르는 것만으로는 아무것도 보내지 않는다.
    await user.click(within(sheet).getByRole('radio', { name: 'Overwrite' }))
    expect(invokeCalls(mockInvoke, 'transfer:send')).toHaveLength(1)
    // 라디오에 포커스가 있을 때 Enter는 고른 결정을 적용한다.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' })
    await pending
    expect(secondDecisions()).toEqual({ 'C:\\dl\\a.jpg': 'overwrite' })

    // 고른 결정은 다음 시트로 이어지지 않는다(기억하기를 켜지 않았다).
    mockInvoke.mockClear()
    answerConflicts([conflict('a.jpg')])
    ;({ pending } = await startSend())
    expect((screen.getByRole('radio', { name: 'Newer only' }) as HTMLInputElement).checked).toBe(
      true
    )
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await pending
    expect(secondDecisions()).toEqual({ 'C:\\dl\\a.jpg': 'skip' })
  })

  it('puts the remember toggle in the footer with Confirm; on at Confirm, the next sheet preselects that choice with the toggle on', async () => {
    // covers: Test-1087
    const user = userEvent.setup()
    answerConflicts([conflict('a.jpg')])
    render(<ConflictSheet />)
    let { pending } = await startSend()
    let sheet = screen.getByRole('alertdialog')
    const remember = within(sheet).getByRole('checkbox', {
      name: 'Remember this decision'
    }) as HTMLInputElement
    expect(remember.checked).toBe(false)
    // 아래쪽(확인 단추와 같은 바닥글)에 있고 선택지보다 뒤에 온다.
    const confirm = within(sheet).getByRole('button', { name: 'Confirm' })
    expect(remember.parentElement?.parentElement).toBe(confirm.parentElement)
    const order = [...sheet.querySelectorAll('input, button')]
    expect(order.indexOf(remember)).toBeGreaterThan(
      order.indexOf(within(sheet).getByRole('radio', { name: 'Skip' }))
    )

    await user.click(within(sheet).getByRole('radio', { name: 'Overwrite' }))
    await user.click(remember)
    await user.click(confirm)
    await pending
    expect(secondDecisions()).toEqual({ 'C:\\dl\\a.jpg': 'overwrite' })
    expect(useSettingsStore.getState().conflictChoice).toBe('overwrite')

    mockInvoke.mockClear()
    answerConflicts([conflict('b.jpg')])
    ;({ pending } = await startSend())
    sheet = screen.getByRole('alertdialog')
    expect(
      (within(sheet).getByRole('radio', { name: 'Overwrite' }) as HTMLInputElement).checked
    ).toBe(true)
    expect(
      (within(sheet).getByRole('checkbox', { name: 'Remember this decision' }) as HTMLInputElement)
        .checked
    ).toBe(true)
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }))
    await pending
    expect(secondDecisions()).toEqual({ 'C:\\dl\\b.jpg': 'overwrite' })
  })

  it('remembers nothing when the toggle is off at Confirm and keeps the value remembered before', async () => {
    // covers: Test-1088
    const user = userEvent.setup()
    useSettingsStore.setState({ conflictChoice: 'skip' })
    answerConflicts([conflict('a.jpg')])
    render(<ConflictSheet />)
    const { pending } = await startSend()
    const sheet = screen.getByRole('alertdialog')
    expect((within(sheet).getByRole('radio', { name: 'Skip' }) as HTMLInputElement).checked).toBe(
      true
    )
    const remember = within(sheet).getByRole('checkbox', {
      name: 'Remember this decision'
    }) as HTMLInputElement
    expect(remember.checked).toBe(true)

    await user.click(remember)
    await decide(user, 'Overwrite', sheet)
    await pending
    expect(secondDecisions()).toEqual({ 'C:\\dl\\a.jpg': 'overwrite' })
    expect(useSettingsStore.getState().conflictChoice).toBe('skip')
  })

  it('offers only keep-both and skip for a folder, preselecting keep-both over a remembered overwrite or newer, and never overwrites a folder through apply-to-rest', async () => {
    // covers: Test-1089
    const user = userEvent.setup()
    useSettingsStore.setState({ conflictChoice: 'overwrite' })
    const dir = conflict('sub', { target: 'C:\\dl\\sub', source: '/photos/sub', folder: true })
    answerConflicts([dir, conflict('b.jpg')])
    render(<ConflictSheet />)
    const { pending } = await startSend()
    const sheet = screen.getByRole('alertdialog')
    const radios = within(sheet).getAllByRole('radio') as HTMLInputElement[]
    expect(radios.map((r) => [r.labels?.[0].textContent, r.checked])).toEqual([
      ['Keep both (rename)', true],
      ['Skip', false]
    ])
    // 폴더가 고른 둘 다 두기가 나머지에도 적용된다. 기억한 값은 폴더 때문에 바뀌지 않는다.
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }))
    await pending
    expect(secondDecisions()).toEqual({
      'C:\\dl\\sub': 'rename',
      'C:\\dl\\b.jpg': 'rename'
    })
    expect(useSettingsStore.getState().conflictChoice).toBe('overwrite')

    // 파일 뒤에 폴더가 오면 나머지에 적용해도 폴더에는 덮어쓰기를 보내지 않는다.
    mockInvoke.mockClear()
    answerConflicts([conflict('b.jpg'), dir])
    const second = await startSend()
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await second.pending
    expect(secondDecisions()).toEqual({
      'C:\\dl\\b.jpg': 'overwrite',
      'C:\\dl\\sub': 'rename'
    })

    // 이미 골라진 둘 다 두기를 눌러 확인하고 기억하면, 미리 고른 값이 아니라 사람이 고른 둘 다 두기를 기억한다.
    useSettingsStore.setState({ conflictChoice: null })
    mockInvoke.mockClear()
    answerConflicts([dir])
    const third = await startSend()
    const folderSheet = screen.getByRole('alertdialog')
    await user.click(within(folderSheet).getByRole('radio', { name: 'Keep both (rename)' }))
    await user.click(within(folderSheet).getByRole('checkbox', { name: 'Remember this decision' }))
    await user.click(within(folderSheet).getByRole('button', { name: 'Confirm' }))
    await third.pending
    expect(secondDecisions()).toEqual({ 'C:\\dl\\sub': 'rename' })
    expect(useSettingsStore.getState().conflictChoice).toBe('rename')
  })

  it('ignores a remembered value that is not a decision: newer-only is selected, remember is off and Confirm sends newer', async () => {
    // covers: Test-1092
    const user = userEvent.setup()
    // 손으로 고쳤거나 나중 버전에서 이름이 바뀐 값. persist는 그대로 합쳐 넣는다
    useSettingsStore.setState({ conflictChoice: 'bogus' as never })
    answerConflicts([conflict('a.jpg')])
    render(<ConflictSheet />)
    const { pending } = await startSend()
    const sheet = screen.getByRole('alertdialog')
    expect(
      (within(sheet).getByRole('radio', { name: 'Newer only' }) as HTMLInputElement).checked
    ).toBe(true)
    expect(
      (within(sheet).getByRole('checkbox', { name: 'Remember this decision' }) as HTMLInputElement)
        .checked
    ).toBe(false)
    await user.click(within(sheet).getByRole('button', { name: 'Confirm' }))
    await pending
    expect(secondDecisions()).toEqual({ 'C:\\dl\\a.jpg': 'newer' })
  })

  it('keeps Tab inside the sheet across the checked radio, apply-to-rest, remember and Confirm', async () => {
    // covers: Test-1090
    answerConflicts([conflict('a.jpg'), conflict('b.jpg')])
    render(<ConflictSheet />)
    await startSend()
    const sheet = screen.getByRole('alertdialog')
    const user = userEvent.setup()
    const names = (): string | null => {
      const el = document.activeElement as HTMLInputElement
      return el.getAttribute('aria-label') ?? el.labels?.[0]?.textContent ?? el.textContent
    }
    expect(names()).toBe('Newer only')
    const seen: Array<string | null> = []
    for (let i = 0; i < 4; i++) {
      await user.tab()
      seen.push(names())
    }
    expect(seen).toEqual([
      'Do the same for the other 1',
      'Remember this decision',
      'Confirm',
      'Cancel'
    ])
    await user.tab({ shift: true })
    expect(names()).toBe('Confirm')
    expect(sheet.contains(document.activeElement)).toBe(true)
  })
})
