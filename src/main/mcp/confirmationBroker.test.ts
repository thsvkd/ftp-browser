import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfirmRequest } from '@shared/types/agent'
import { ConfirmationBroker, type AgentWindow, type ConfirmInput } from './confirmationBroker'

function fakeWindow(minimized = false): AgentWindow & { sent: Array<[string, unknown]> } {
  const sent: Array<[string, unknown]> = []
  let isMinimized = minimized
  return {
    sent,
    isDestroyed: () => false,
    isMinimized: () => isMinimized,
    restore: vi.fn(() => {
      isMinimized = false
    }),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: {
      send: vi.fn((channel: string, payload: unknown) => sent.push([channel, payload]))
    }
  }
}

function input(tool: string): ConfirmInput {
  return { tool, tier: 'D', items: [{ path: `/${tool}`, kind: 'file' }], totalItems: 1 }
}

function requests(win: ReturnType<typeof fakeWindow>): AgentConfirmRequest[] {
  return win.sent
    .filter(([channel]) => channel === 'agent:confirmRequest')
    .map(([, payload]) => payload as AgentConfirmRequest)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ConfirmationBroker', () => {
  it('times out unanswered requests, tells the renderer, and refuses without a window', async () => {
    // covers: Test-455
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'))
    const win = fakeWindow(true)
    const broker = new ConfirmationBroker(() => win, 120_000)

    const outcome = broker.request(input('delete'))
    const [request] = requests(win)
    expect(request).toMatchObject({ tool: 'delete', expiresAt: '2026-10-04T00:02:00.000Z' })
    expect(win.restore).toHaveBeenCalled()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(119_999)
    expect(win.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(outcome).resolves.toBe('timeout')
    expect(win.sent[1]).toEqual(['agent:confirmCancelled', request.id])
    // 시간이 지난 뒤의 응답은 무시한다.
    broker.respond(request.id, true)

    await expect(new ConfirmationBroker(() => null).request(input('x'))).resolves.toBe(
      'unavailable'
    )
    const destroyed = { ...fakeWindow(), isDestroyed: () => true }
    await expect(new ConfirmationBroker(() => destroyed).request(input('x'))).resolves.toBe(
      'unavailable'
    )
    expect(destroyed.sent).toEqual([])
  })

  it('shows one request at a time and the rest in arrival order', async () => {
    // covers: Test-456
    const win = fakeWindow()
    const broker = new ConfirmationBroker(() => win, 60_000)

    const first = broker.request(input('one'))
    const second = broker.request(input('two'))
    const third = broker.request(input('three'))
    expect(requests(win).map((r) => r.tool)).toEqual(['one'])

    broker.respond(requests(win)[0].id, true)
    await expect(first).resolves.toBe('approved')
    expect(requests(win).map((r) => r.tool)).toEqual(['one', 'two'])

    // 대기 중인 요청의 id로 답해도 순서를 건너뛰지 않는다.
    broker.respond('not-shown', true)
    broker.respond(requests(win)[1].id, false)
    await expect(second).resolves.toBe('denied')
    expect(requests(win).map((r) => r.tool)).toEqual(['one', 'two', 'three'])

    broker.respond(requests(win)[2].id, true)
    await expect(third).resolves.toBe('approved')
    expect(win.sent.filter(([channel]) => channel === 'agent:confirmCancelled')).toEqual([])
  })

  it('drops a request whose MCP call was abandoned, shown or still queued', async () => {
    // covers: Test-473
    const win = fakeWindow()
    const broker = new ConfirmationBroker(() => win, 60_000)
    const shownCall = new AbortController()
    const queuedCall = new AbortController()

    const shown = broker.request(input('one'), shownCall.signal)
    const queued = broker.request(input('two'), queuedCall.signal)
    const last = broker.request(input('three'))

    queuedCall.abort()
    await expect(queued).resolves.toBe('aborted')
    shownCall.abort()
    await expect(shown).resolves.toBe('aborted')

    const [one, three] = requests(win)
    expect(requests(win).map((r) => r.tool)).toEqual(['one', 'three'])
    expect(win.sent[1]).toEqual(['agent:confirmCancelled', one.id])
    broker.respond(three.id, true)
    await expect(last).resolves.toBe('approved')
  })
})
