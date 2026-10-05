import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

import { ipcMain } from 'electron'
import { registerAgentHandlers } from './agentHandlers'
import type { AgentPolicyStore } from '../mcp/agentPolicy'
import type { ConfirmationBroker } from '../mcp/confirmationBroker'

type Handler = (event: unknown, ...args: unknown[]) => unknown

describe('registerAgentHandlers', () => {
  let handlers: Map<string, Handler>

  beforeEach(() => {
    vi.clearAllMocks()
    handlers = new Map()
    vi.mocked(ipcMain.handle).mockImplementation(((channel: string, listener: Handler) => {
      handlers.set(channel, listener)
    }) as unknown as typeof ipcMain.handle)
  })

  it('answers confirmations and reads or writes the policy as IpcResult values', async () => {
    // covers: Test-466
    const policy = { W: 'allow', D: 'ask', X: 'ask', C: 'deny' }
    const store = {
      get: vi.fn(() => policy),
      set: vi.fn((value: unknown) => {
        if (value === 'bad') throw new Error('Invalid agent policy')
        return value
      })
    } as unknown as AgentPolicyStore
    const broker = { respond: vi.fn() } as unknown as ConfirmationBroker

    registerAgentHandlers(store, broker)
    const call = (channel: string, ...args: unknown[]): Promise<unknown> =>
      Promise.resolve().then(() => handlers.get(channel)?.(null, ...args))

    expect([...handlers.keys()].sort()).toEqual([
      'agent:confirmRespond',
      'agent:getPolicy',
      'agent:setPolicy'
    ])
    await expect(call('agent:confirmRespond', 'req-1', true)).resolves.toEqual({
      success: true,
      data: undefined
    })
    // approved는 true일 때만 승인이다(렌더러가 이상한 값을 보내도 실행하지 않는다).
    await call('agent:confirmRespond', 'req-2', 'yes')
    expect(vi.mocked(broker.respond).mock.calls).toEqual([
      ['req-1', true],
      ['req-2', false]
    ])
    await expect(call('agent:getPolicy')).resolves.toEqual({ success: true, data: policy })
    await expect(call('agent:setPolicy', policy)).resolves.toEqual({ success: true, data: policy })
    await expect(call('agent:setPolicy', 'bad')).resolves.toEqual({
      success: false,
      error: 'Invalid agent policy',
      code: 'UNKNOWN'
    })
  })
})
