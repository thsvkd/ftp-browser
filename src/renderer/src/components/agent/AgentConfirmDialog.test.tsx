/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import { ConfirmDialog } from '@renderer/components/common/ConfirmDialog'
import { confirmDialog } from '@renderer/stores/useConfirmStore'
import { useAgentConfirmStore } from '@renderer/stores/useAgentConfirmStore'
import { en } from '@renderer/i18n/locales/en'
import type { AgentConfirmRequest } from '@shared/types/agent'
import { AgentConfirmDialog } from './AgentConfirmDialog'

const mockInvoke = vi.fn()
const listeners = new Map<string, (...args: unknown[]) => void>()

function emit(channel: string, payload: unknown): void {
  const listener = listeners.get(channel)
  if (!listener) throw new Error(`nobody listens to ${channel}`)
  act(() => listener(payload))
}

function request(overrides: Partial<AgentConfirmRequest> = {}): AgentConfirmRequest {
  return {
    id: 'r1',
    tool: 'delete',
    tier: 'D',
    client: 'claude-code',
    host: 'nas.local',
    items: [
      { path: '/photos/a.jpg', kind: 'file', size: 2048 },
      { path: '/photos/old', kind: 'directory' }
    ],
    totalItems: 25,
    totalBytes: 10 * 1024 * 1024,
    expiresAt: '2026-10-05T00:02:00.000Z',
    ...overrides
  }
}

const dialog = (): HTMLElement => screen.getByRole('alertdialog')
const responses = (): unknown[][] => invokeCalls(mockInvoke, 'agent:confirmRespond')

beforeEach(() => {
  vi.clearAllMocks()
  listeners.clear()
  mockInvoke.mockResolvedValue({ success: true, data: undefined })
  const api = makeApiMock(mockInvoke)
  api.on.mockImplementation((channel: string, callback: (...args: unknown[]) => void) => {
    listeners.set(channel, callback)
    return () => listeners.delete(channel)
  })
  vi.stubGlobal('api', api)
  useAgentConfirmStore.setState({ queue: [] })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AgentConfirmDialog', () => {
  it('shows the tier, tool, items and totals, focuses Deny, and answers each way', async () => {
    // covers: Test-504
    const user = userEvent.setup()
    render(<AgentConfirmDialog />)

    emit('agent:confirmRequest', request())

    const panel = within(dialog())
    expect(screen.getByRole('alertdialog', { name: /Delete remote items/ })).toBeTruthy()
    expect(panel.getByText('D')).toBeTruthy()
    expect(panel.getByText('Destructive')).toBeTruthy()
    expect(panel.getByText('claude-code')).toBeTruthy()
    expect(panel.getByText('nas.local')).toBeTruthy()
    expect(panel.getByText('/photos/a.jpg')).toBeTruthy()
    expect(panel.getByText('/photos/old')).toBeTruthy()
    expect(panel.getByText('2 KB')).toBeTruthy()
    // 삭제의 items는 최상위 대상이고 totalItems는 폴더 안까지 센 수다. 둘의 차를 "N개 더"로 보이지 않는다.
    expect(panel.getByText('Total: 25 items, 10 MB')).toBeTruthy()
    expect(panel.queryByText(/more/)).toBeNull()
    expect(document.activeElement).toBe(panel.getByRole('button', { name: 'Deny' }))

    await user.click(panel.getByRole('button', { name: 'Allow' }))
    expect(responses()).toEqual([['r1', true]])
    expect(screen.queryByRole('alertdialog')).toBeNull()

    emit('agent:confirmRequest', request({ id: 'r2' }))
    await user.keyboard('{Escape}')
    expect(responses()).toEqual([
      ['r1', true],
      ['r2', false]
    ])
    expect(screen.queryByRole('alertdialog')).toBeNull()

    emit('agent:confirmRequest', request({ id: 'r3' }))
    // 기본 포커스가 거부이므로 Enter만 눌러도 거부된다.
    await user.keyboard('{Enter}')
    expect(responses().at(-1)).toEqual(['r3', false])

    emit('agent:confirmRequest', request({ id: 'r4' }))
    fireEvent.click(dialog().parentElement!)
    expect(responses().at(-1)).toEqual(['r4', false])
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('marks uploads that overwrite and omits the size total when main sent none', () => {
    render(<AgentConfirmDialog />)
    emit(
      'agent:confirmRequest',
      request({
        tool: 'upload',
        tier: 'X',
        items: [{ path: '/site/index.html', kind: 'file', size: 10, overwrites: true }],
        totalItems: 1,
        totalBytes: undefined,
        client: undefined
      })
    )

    const panel = within(dialog())
    expect(screen.getByRole('alertdialog', { name: /Upload files to the server/ })).toBeTruthy()
    expect(panel.getByText('Overwrites')).toBeTruthy()
    expect(panel.getByText('Total: 1 item')).toBeTruthy()
    expect(panel.getByText('Unknown')).toBeTruthy()
  })

  it('renders remote names and the client name as plain text, newlines made visible', () => {
    // covers: Test-505
    render(<AgentConfirmDialog />)
    const evilPath = '/x/<img src=x onerror="alert(1)">\nrm -rf.jpg'
    emit(
      'agent:confirmRequest',
      request({
        client: '<b>trusted</b>\r\nclaude',
        items: [
          { path: evilPath, kind: 'file', size: 1 },
          { path: '/x/<a href="https://evil.example">link</a>', kind: 'directory' },
          { path: '/x/photo‮gpj.exe', kind: 'file' }
        ],
        totalItems: 3
      })
    )

    const panel = dialog()
    expect(panel.querySelector('img, b, a')).toBeNull()
    expect(panel.textContent).toContain('/x/<img src=x onerror="alert(1)">\\nrm -rf.jpg')
    expect(panel.textContent).toContain('<b>trusted</b>\\r\\nclaude')
    expect(panel.textContent).toContain('<a href="https://evil.example">link</a>')
    // 방향 제어 문자는 이름을 뒤집어 보이게 하므로 보이는 표기로 바꾼다.
    expect(panel.textContent).toContain('/x/photo\\u202Egpj.exe')
    expect(panel.textContent).not.toMatch(/[\r\n‮]/)
  })

  it('closes the dialog when main cancels the request, without answering it', () => {
    // covers: Test-506
    render(<AgentConfirmDialog />)
    emit('agent:confirmRequest', request({ id: 'r1' }))
    emit('agent:confirmRequest', request({ id: 'r2', tool: 'upload', tier: 'X' }))

    // 대기 중인 요청이 취소되면 나중에 보이지 않는다.
    emit('agent:confirmCancelled', 'r2')
    expect(screen.getByRole('alertdialog', { name: /Delete remote items/ })).toBeTruthy()

    emit('agent:confirmCancelled', 'r1')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(responses()).toEqual([])
  })

  it('does not cancel a confirmation the user already has open (separate slot)', async () => {
    // covers: Test-507
    const user = userEvent.setup()
    render(
      <>
        <ConfirmDialog />
        <AgentConfirmDialog />
      </>
    )
    let answer: Promise<boolean> | undefined
    act(() => {
      answer = confirmDialog({ title: 'Delete "a.jpg"?', confirmLabel: 'Delete' })
    })

    emit('agent:confirmRequest', request())
    expect(screen.getAllByRole('alertdialog')).toHaveLength(2)

    await user.click(
      within(screen.getByRole('alertdialog', { name: /Delete remote items/ })).getByRole('button', {
        name: 'Deny'
      })
    )
    expect(responses()).toEqual([['r1', false]])

    const own = screen.getByRole('alertdialog', { name: 'Delete "a.jpg"?' })
    await user.click(within(own).getByRole('button', { name: 'Delete' }))
    await expect(answer).resolves.toBe(true)
  })

  it('shows queued requests one at a time, in arrival order', async () => {
    // covers: Test-517
    const user = userEvent.setup()
    render(<AgentConfirmDialog />)
    emit('agent:confirmRequest', request({ id: 'r1' }))
    emit('agent:confirmRequest', request({ id: 'r2', tool: 'upload', tier: 'X' }))
    // 같은 요청이 두 번 와도 한 번만 묻는다.
    emit('agent:confirmRequest', request({ id: 'r2', tool: 'upload', tier: 'X' }))

    expect(screen.getAllByRole('alertdialog')).toHaveLength(1)
    expect(screen.getByRole('alertdialog', { name: /Delete remote items/ })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Allow' }))
    expect(screen.getByRole('alertdialog', { name: /Upload files to the server/ })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Deny' }))

    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(responses()).toEqual([
      ['r1', true],
      ['r2', false]
    ])
  })

  it('has a localized title for every tool of spec §2.2 and shows unknown tools by name', () => {
    // covers: Test-518
    const tools = [
      'get_status',
      'list_servers',
      'list_directory',
      'get_image_previews',
      'list_local_directory',
      'list_jobs',
      'wait_for_jobs',
      'connect',
      'disconnect',
      'create_directory',
      'rename',
      'download',
      'cancel_jobs',
      'clear_finished_jobs',
      'create_local_directory',
      'rename_local',
      'delete',
      'delete_local',
      'upload',
      'open_server_editor',
      'delete_server'
    ]
    const messages = en as Record<string, string>
    for (const tool of tools) expect(messages[`agent.tool.${tool}`], tool).toBeTypeOf('string')
    for (const tier of ['R', 'W', 'D', 'X', 'C']) {
      expect(messages[`agent.tier.${tier}`], tier).toBeTypeOf('string')
    }

    render(<AgentConfirmDialog />)
    emit('agent:confirmRequest', request({ tool: 'future_tool', tier: 'W' }))
    expect(screen.getByRole('alertdialog', { name: /future_tool/ })).toBeTruthy()
  })

  it('tells the user when the answer could not be sent', async () => {
    const { toast } = await import('sonner')
    const error = vi.spyOn(toast, 'error').mockReturnValue('id')
    mockInvoke.mockRejectedValue(new Error('IPC channel closed'))
    const user = userEvent.setup()
    render(<AgentConfirmDialog />)
    emit('agent:confirmRequest', request())

    await user.click(screen.getByRole('button', { name: 'Allow' }))

    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith("Couldn't send your answer to the agent", {
        description: 'IPC channel closed'
      })
    )
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
