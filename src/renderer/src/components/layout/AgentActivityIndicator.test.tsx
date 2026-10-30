/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { toast } from 'sonner'
import { makeApiMock, invokeCalls, type ApiMock } from '@renderer/test/rendererTestUtils'
import type { AgentActivityEvent } from '@shared/types/mcp'
import { AGENT_ACTIVITY_LINGER_MS, AgentActivityIndicator } from './AgentActivityIndicator'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

const mockInvoke = vi.fn()
let api: ApiMock

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockResolvedValue({ success: true, data: undefined })
  api = makeApiMock(mockInvoke)
  vi.stubGlobal('api', api)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** 컴포넌트가 구독한 `agent:activity` 콜백으로 이벤트를 보낸다. */
function emit(event: AgentActivityEvent): void {
  const listener = api.on.mock.calls.find((c) => c[0] === 'agent:activity')?.[1] as
    | ((event: AgentActivityEvent) => void)
    | undefined
  act(() => listener!(event))
}

const glow = (): Element | null => document.querySelector('[data-agent-glow]')
const pill = (): HTMLElement => document.querySelector('[data-agent-pill]') as HTMLElement
const shown = (): boolean => document.querySelector('[data-agent-pill]') !== null
const stopButton = (): HTMLElement | null =>
  screen.queryByRole('button', { name: 'Stop all agents' })

describe('AgentActivityIndicator', () => {
  it('shows the glow and a status pill while an agent works, then fades out', () => {
    // covers: Test-1351
    vi.useFakeTimers()
    render(<AgentActivityIndicator />)
    expect(shown()).toBe(false)
    // live region은 처음부터 비어 있는 채로 있다
    expect(screen.getByRole('status').textContent).toBe('')
    expect(glow()).toBeNull()

    emit({ active: true, client: 'Codex', tool: 'list_directory', target: '/photos' })
    // 알림(live region)은 누가 일하는지만 읽고, 동작·대상은 pill에 보이기만 한다
    expect(screen.getByRole('status').textContent).toBe('Codex is working')
    expect(pill().textContent).toContain('Reading folder')
    expect(pill().textContent).toContain('/photos')
    expect(glow()).not.toBeNull()

    // 호출 사이: 남아 있다가 사라진다
    emit({ active: false, client: 'Codex', tool: 'list_directory', target: '/photos' })
    act(() => vi.advanceTimersByTime(AGENT_ACTIVITY_LINGER_MS - 1))
    expect(shown()).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(shown()).toBe(false)
    expect(glow()).toBeNull()
  })

  it('names an unknown agent generically and closes at once after a stop', () => {
    // covers: Test-1351
    render(<AgentActivityIndicator />)

    emit({ active: true, tool: 'delete', target: '/old' })
    expect(screen.getByRole('status').textContent).toBe('Agent is working')
    expect(pill().textContent).toContain('Deleting')

    emit({ active: false, stopped: true, tool: 'delete' })
    expect(shown()).toBe(false)
  })

  it('stops the agent from the pill and reports a failed stop', async () => {
    // covers: Test-1352
    render(<AgentActivityIndicator />)
    emit({ active: true, client: 'Claude Code', tool: 'download', target: '/a.jpg' })

    fireEvent.click(screen.getByRole('button', { name: 'Stop all agents' }))
    expect(invokeCalls(mockInvoke, 'agent:stop')).toHaveLength(1)

    mockInvoke.mockResolvedValueOnce({ success: false, error: 'boom' })
    fireEvent.click(screen.getByRole('button', { name: 'Stop all agents' }))
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't stop the agent", { description: 'boom' })
    )

    mockInvoke.mockRejectedValueOnce(new Error('gone'))
    fireEvent.click(screen.getByRole('button', { name: 'Stop all agents' }))
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't stop the agent", { description: 'gone' })
    )
  })

  it('starts from the activity already running when the window loads', async () => {
    // covers: Test-1363
    mockInvoke.mockImplementation(async (channel: string) =>
      channel === 'agent:getActivity'
        ? { success: true, data: { active: true, client: 'Codex', tool: 'download' } }
        : { success: true, data: undefined }
    )
    render(<AgentActivityIndicator />)

    await vi.waitFor(() => expect(screen.getByRole('status').textContent).toBe('Codex is working'))
    expect(invokeCalls(mockInvoke, 'agent:getActivity')).toHaveLength(1)
  })

  it('ignores a stale snapshot once an event has arrived, and an idle one', async () => {
    // covers: Test-1363
    let answer: (value: unknown) => void = () => undefined
    mockInvoke.mockImplementation((channel: string) =>
      channel === 'agent:getActivity'
        ? new Promise((resolve) => (answer = resolve))
        : Promise.resolve({ success: true, data: undefined })
    )
    render(<AgentActivityIndicator />)
    emit({ active: false, stopped: true })
    await act(async () => answer({ success: true, data: { active: true, tool: 'delete' } }))
    expect(shown()).toBe(false)

    cleanup()
    mockInvoke.mockResolvedValue({ success: true, data: { active: false, tool: 'delete' } })
    render(<AgentActivityIndicator />)
    await act(async () => undefined)
    expect(shown()).toBe(false)
  })

  it('stops pulsing and drops below dialogs while it lingers, and a new call keeps it up', () => {
    // covers: Test-1364
    vi.useFakeTimers()
    render(<AgentActivityIndicator />)
    emit({ active: true, tool: 'list_directory' })
    expect(glow()?.getAttribute('data-active')).toBe('true')
    expect(pill().className).toContain('z-[71]')
    expect(stopButton()?.getAttribute('aria-disabled')).toBe('false')

    // 남아 있는 동안은 멈출 것이 없다: 버튼 없이 클릭을 통과시킨다
    emit({ active: false, tool: 'list_directory' })
    expect(glow()?.getAttribute('data-active')).toBe('false')
    expect(pill().className).toContain('z-40')
    expect(pill().className).toContain('pointer-events-none')
    expect(stopButton()?.getAttribute('aria-disabled')).toBe('true')
    act(() => vi.advanceTimersByTime(AGENT_ACTIVITY_LINGER_MS - 1))

    emit({ active: true, tool: 'download' })
    act(() => vi.advanceTimersByTime(AGENT_ACTIVITY_LINGER_MS * 2))
    expect(shown()).toBe(true)
    expect(pill().className).toContain('z-[71]')
    expect(stopButton()?.getAttribute('aria-disabled')).toBe('false')
  })

  it('says the agent stopped while a transfer it could not cancel finishes', () => {
    // covers: Test-1371
    render(<AgentActivityIndicator />)
    emit({ active: true, client: 'Codex', tool: 'download', target: '/a.txt' })

    emit({ active: true, stopping: true, client: 'Codex', tool: 'download', target: '/a.txt' })

    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Codex stopped')
    expect(pill().textContent).toContain("A transfer that can't be cancelled is finishing")
    expect(pill().textContent).not.toContain('is working')
    // 꺼진 [중지]는 눌러도 아무것도 하지 않는다
    fireEvent.click(stopButton()!)
    expect(invokeCalls(mockInvoke, 'agent:stop')).toEqual([])
    expect(stopButton()?.getAttribute('aria-disabled')).toBe('true')
    expect(pill().className).toContain('pointer-events-none')
    expect(glow()?.getAttribute('data-active')).toBe('false')
    // 알릴 글만 live region에 있다
    expect(status.querySelector('button')).toBeNull()
  })

  it('truncates a long agent name so Stop stays in the pill', () => {
    // covers: Test-1365
    render(<AgentActivityIndicator />)
    emit({ active: true, client: '﷽'.repeat(40), tool: 'download' })
    const name = pill().querySelector('[aria-hidden]:not(svg)') as HTMLElement
    expect(name.textContent).toContain('is working')
    expect(name.className).toContain('truncate')
    expect(name.className).toContain('max-w-[14rem]')
    expect(name.className).not.toContain('shrink-0')
    expect(screen.getByRole('button', { name: 'Stop all agents' }).className).toContain('shrink-0')
  })

  it('gives focus back to where it was when the pill closes under a focused Stop', async () => {
    // covers: Test-1377
    const outside = document.createElement('button')
    document.body.append(outside)
    onTestFinished(() => outside.remove())
    render(<AgentActivityIndicator />)
    emit({ active: true, client: 'Codex', tool: 'download' })
    outside.focus()
    stopButton()!.focus()

    fireEvent.click(stopButton()!)
    await act(async () => undefined)
    emit({ active: false, stopped: true })

    expect(shown()).toBe(false)
    expect(document.activeElement).toBe(outside)
  })

  it('leaves focus alone when the user already left Stop before the pill closes', () => {
    // covers: Test-1381
    const outside = document.createElement('button')
    document.body.append(outside)
    onTestFinished(() => outside.remove())
    render(<AgentActivityIndicator />)
    emit({ active: true, client: 'Codex', tool: 'download' })
    outside.focus()
    stopButton()!.focus()
    // 포커스할 수 없는 빈 곳을 눌러 [중지]를 떠난다
    act(() => stopButton()!.blur())
    expect(document.activeElement).toBe(document.body)

    emit({ active: false, stopped: true })

    expect(shown()).toBe(false)
    expect(document.activeElement).toBe(document.body)
  })
})
