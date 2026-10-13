/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import { useTransferStore } from '@renderer/stores/useTransferStore'
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
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ConflictSheet', () => {
  it('shows the first conflict as two cards with the newer badge, apply-to-rest on and keep-both focused; cancel sends nothing more', async () => {
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
    expect(document.activeElement).toBe(
      within(sheet).getByRole('button', { name: 'Keep both (rename)' })
    )

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

    await user.click(screen.getByRole('button', { name: 'Keep both (rename)' }))
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
    await user.click(screen.getByRole('button', { name: 'Overwrite' }))
    expect(screen.getByText('"b.jpg" already exists')).toBeTruthy()
    expect(screen.getByText(/Conflict 2 of 2/)).toBeTruthy()
    expect(invokeCalls(mockInvoke, 'transfer:send')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Skip' }))
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

    await userEvent.setup().click(screen.getByRole('button', { name: 'Newer only' }))
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
    await userEvent.setup().click(screen.getByRole('button', { name: 'Overwrite' }))
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
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Cancel', 'Keep both (rename)', 'Skip'])
    await userEvent.setup().click(within(sheet).getByRole('button', { name: 'Skip' }))
    await expect(answer).resolves.toEqual({ 'C:\\dst\\sub': 'skip' })
  })
})
