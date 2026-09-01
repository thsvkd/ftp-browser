/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { makeApiMock } from '@renderer/test/rendererTestUtils'
import { useUpdateListener } from './useUpdateListener'

vi.mock('sonner', () => ({
  toast: { message: vi.fn(), success: vi.fn() }
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useUpdateListener', () => {
  it('announces available and downloaded updates with user actions', () => {
    // covers: Test-209
    let listener: ((state: unknown) => void) | undefined
    const invoke = vi.fn()
    const api = makeApiMock(invoke)
    api.on.mockImplementation((_channel, callback) => {
      listener = callback
      return () => undefined
    })
    vi.stubGlobal('api', api)
    const openSettings = vi.fn()

    renderHook(() => useUpdateListener(openSettings))
    listener?.({ status: 'available', currentVersion: '1.0.5', availableVersion: '1.0.6' })

    expect(toast.message).toHaveBeenCalledWith('Version 1.0.6 is available', {
      action: { label: 'View', onClick: openSettings }
    })
    const availableAction = vi.mocked(toast.message).mock.calls[0][1]?.action as
      | { onClick: (event: React.MouseEvent) => void }
      | undefined
    if (!availableAction) throw new Error('Available update toast has no action')
    availableAction.onClick({} as React.MouseEvent)
    expect(openSettings).toHaveBeenCalledTimes(1)

    listener?.({ status: 'ready', currentVersion: '1.0.5', availableVersion: '1.0.6' })

    expect(toast.success).toHaveBeenCalledWith('Version 1.0.6 is ready to install', {
      action: { label: 'View', onClick: openSettings }
    })
    const readyAction = vi.mocked(toast.success).mock.calls[0][1]?.action as
      | { onClick: (event: React.MouseEvent) => void }
      | undefined
    if (!readyAction) throw new Error('Ready update toast has no action')
    readyAction.onClick({} as React.MouseEvent)
    expect(openSettings).toHaveBeenCalledTimes(2)
    expect(invoke).not.toHaveBeenCalled()

    // 알릴 것이 없는 상태는 조용해야 한다. 이 단언이 없으면 두 분기 조건을 상수로 바꿔도
    // 통과해, 사용자가 확인·다운로드 중에도 토스트를 맞는 구현이 그대로 살아남는다.
    for (const status of ['idle', 'checking', 'downloading', 'up-to-date', 'error'] as const) {
      listener?.({ status, currentVersion: '1.0.5' })
    }
    expect(toast.message).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledTimes(1)
  })
})
