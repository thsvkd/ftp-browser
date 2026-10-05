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

  it('shows where the action writes, labelled, for uploads, downloads and renames', async () => {
    // covers: Test-645
    const user = userEvent.setup()
    render(<AgentConfirmDialog />)
    const writes: [Partial<AgentConfirmRequest>, string][] = [
      [{ id: 'up', tool: 'upload', tier: 'X', destination: '/site/public' }, '/site/public'],
      [
        { id: 'down', tool: 'download', tier: 'W', destination: 'C:\\Users\\kim\\Desktop' },
        'C:\\Users\\kim\\Desktop'
      ],
      [
        { id: 'mv', tool: 'rename', tier: 'W', destination: '/photos/2026/b.jpg' },
        '/photos/2026/b.jpg'
      ]
    ]
    for (const [overrides, shown] of writes) {
      emit('agent:confirmRequest', request(overrides))
      const label = within(dialog()).getByText('To')
      // 라벨과 값이 한 쌍(dt·dd)이다.
      expect(label.tagName).toBe('DT')
      expect(label.nextElementSibling?.textContent).toBe(shown)
      await user.click(within(dialog()).getByRole('button', { name: 'Deny' }))
    }

    // 목적지가 없는 요청(삭제)에는 그 줄이 없다.
    emit('agent:confirmRequest', request({ id: 'rm' }))
    expect(within(dialog()).queryByText('To')).toBeNull()
  })

  it('renders the destination and the self-declared client name as escaped text', () => {
    // covers: Test-646
    render(<AgentConfirmDialog />)
    emit(
      'agent:confirmRequest',
      request({
        tool: 'upload',
        tier: 'X',
        client: 'claude\u200b-code\u0085',
        host: 'nas\u2060.local\ufeff',
        destination: '/up/<img src=x onerror="alert(1)">\nx/photo\u202egpj\u200d\u009b'
      })
    )

    const panel = dialog()
    expect(panel.querySelector('img')).toBeNull()
    // 폭 없는 문자와 C1이 숨으면 'claude-code'로 보인다. 보이는 표기로 바꾼다.
    expect(within(panel).queryByText('claude-code')).toBeNull()
    expect(panel.textContent).toContain('claude\\u200B-code\\u0085')
    expect(panel.textContent).toContain('nas\\u2060.local\\uFEFF')
    expect(panel.textContent).toContain(
      '/up/<img src=x onerror="alert(1)">\\nx/photo\\u202Egpj\\u200D\\u009B'
    )
    expect(panel.textContent).not.toMatch(
      /[\n\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/
    )
  })

  it('shows local writes with the W badge, their title and the Downloads-folder rule', async () => {
    // covers: Test-648
    const user = userEvent.setup()
    render(<AgentConfirmDialog />)
    const rule =
      'Outside your Downloads folder, the agent must ask before writing to this computer.'
    const localWrites: [string, RegExp][] = [
      ['download', /Download files/],
      ['create_local_directory', /Create a local folder/],
      ['rename_local', /Rename local items/]
    ]
    for (const [tool, title] of localWrites) {
      emit(
        'agent:confirmRequest',
        request({ id: tool, tool, tier: 'W', host: undefined, destination: '/home/kim/.ssh' })
      )
      const panel = within(screen.getByRole('alertdialog', { name: title }))
      expect(panel.getByText('W')).toBeTruthy()
      expect(panel.getByText('Change')).toBeTruthy()
      expect(panel.getByText(rule)).toBeTruthy()
      await user.click(panel.getByRole('button', { name: 'Deny' }))
    }

    // 원격에 쓰는 W 도구와 다른 등급의 도구에는 이 안내가 없다.
    const others = [
      ['create_directory', 'W'],
      ['upload', 'X'],
      ['delete_local', 'D']
    ] as const
    for (const [tool, tier] of others) {
      emit('agent:confirmRequest', request({ id: tool, tool, tier }))
      expect(within(dialog()).queryByText(rule)).toBeNull()
      await user.click(within(dialog()).getByRole('button', { name: 'Deny' }))
    }
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
