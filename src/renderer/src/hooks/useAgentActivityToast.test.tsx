/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { makeApiMock } from '@renderer/test/rendererTestUtils'
import { useAgentActivityToast } from './useAgentActivityToast'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }
}))

let listener: ((...args: unknown[]) => void) | undefined

beforeEach(() => {
  vi.clearAllMocks()
  const api = makeApiMock(vi.fn())
  api.on.mockImplementation((channel: string, callback: (...args: unknown[]) => void) => {
    if (channel === 'agent:activity') listener = callback
    return () => undefined
  })
  vi.stubGlobal('api', api)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useAgentActivityToast', () => {
  it('shows a short localized toast for each agent action and refusal', () => {
    // covers: Test-511
    renderHook(() => useAgentActivityToast())

    listener?.({ tool: 'delete', tier: 'D', outcome: 'done', totalItems: 3 })
    listener?.({ tool: 'download', tier: 'W', outcome: 'started', totalItems: 1 })
    listener?.({ tool: 'upload', tier: 'X', outcome: 'denied' })
    listener?.({ tool: 'rename', tier: 'W', outcome: 'failed' })

    expect(toast.success).toHaveBeenCalledWith('Agent finished: Delete remote items', {
      description: '3 items'
    })
    expect(toast.info).toHaveBeenCalledWith('Agent started: Download files', {
      description: '1 item'
    })
    expect(toast.warning).toHaveBeenCalledWith('Agent request denied: Upload files to the server', {
      description: undefined
    })
    expect(toast.error).toHaveBeenCalledWith('Agent action failed: Rename or move remote items', {
      description: undefined
    })
  })

  it('leaves out the item count for actions without items', () => {
    // covers: Test-651
    renderHook(() => useAgentActivityToast())

    listener?.({ tool: 'connect', tier: 'W', outcome: 'done', totalItems: 0 })
    listener?.({ tool: 'cancel_jobs', tier: 'W', outcome: 'done', totalItems: 2 })

    expect(toast.success).toHaveBeenCalledWith('Agent finished: Connect to a saved server', {
      description: undefined
    })
    expect(toast.success).toHaveBeenCalledWith(
      'Agent finished: Cancel transfers and file operations',
      { description: '2 items' }
    )
  })
})
