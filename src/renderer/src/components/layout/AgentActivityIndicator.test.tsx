/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('AgentActivityIndicator', () => {
  it('shows the glow and a status pill while an agent works, then fades out', () => {
    // covers: Test-1351
    vi.useFakeTimers()
    render(<AgentActivityIndicator />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(glow()).toBeNull()

    emit({ active: true, client: 'Codex', tool: 'list_directory', target: '/photos' })
    const pill = screen.getByRole('status')
    expect(pill.textContent).toContain('Codex is working')
    expect(pill.textContent).toContain('Reading folder')
    expect(pill.textContent).toContain('/photos')
    expect(glow()).not.toBeNull()

    // 호출 사이: 남아 있다가 사라진다
    emit({ active: false, client: 'Codex', tool: 'list_directory', target: '/photos' })
    act(() => vi.advanceTimersByTime(AGENT_ACTIVITY_LINGER_MS - 1))
    expect(screen.queryByRole('status')).not.toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole('status')).toBeNull()
    expect(glow()).toBeNull()
  })

  it('names an unknown agent generically and closes at once after a stop', () => {
    // covers: Test-1351
    render(<AgentActivityIndicator />)

    emit({ active: true, tool: 'delete', target: '/old' })
    expect(screen.getByRole('status').textContent).toContain('Agent is working')
    expect(screen.getByRole('status').textContent).toContain('Deleting')

    emit({ active: false, stopped: true, tool: 'delete' })
    expect(screen.queryByRole('status')).toBeNull()
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

    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      expect.stringContaining('Codex is working')
    )
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
    expect(screen.queryByRole('status')).toBeNull()

    cleanup()
    mockInvoke.mockResolvedValue({ success: true, data: { active: false, tool: 'delete' } })
    render(<AgentActivityIndicator />)
    await act(async () => undefined)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('stops pulsing and drops below dialogs while it lingers, and a new call keeps it up', () => {
    // covers: Test-1364
    vi.useFakeTimers()
    render(<AgentActivityIndicator />)
    emit({ active: true, tool: 'list_directory' })
    expect(glow()?.getAttribute('data-active')).toBe('true')
    expect(screen.getByRole('status').className).toContain('z-[71]')

    emit({ active: false, tool: 'list_directory' })
    expect(glow()?.getAttribute('data-active')).toBe('false')
    expect(screen.getByRole('status').className).toContain('z-40')
    act(() => vi.advanceTimersByTime(AGENT_ACTIVITY_LINGER_MS - 1))

    emit({ active: true, tool: 'download' })
    act(() => vi.advanceTimersByTime(AGENT_ACTIVITY_LINGER_MS * 2))
    expect(screen.queryByRole('status')).not.toBeNull()
    expect(screen.getByRole('status').className).toContain('z-[71]')
  })

  it('truncates a long agent name so Stop stays in the pill', () => {
    // covers: Test-1365
    render(<AgentActivityIndicator />)
    emit({ active: true, client: '﷽'.repeat(40), tool: 'download' })
    const name = screen.getByText(/is working/)
    expect(name.className).toContain('truncate')
    expect(name.className).toContain('max-w-[14rem]')
    expect(name.className).not.toContain('shrink-0')
    expect(screen.getByRole('button', { name: 'Stop all agents' }).className).toContain('shrink-0')
  })
})
