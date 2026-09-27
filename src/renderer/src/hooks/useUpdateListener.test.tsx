/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { makeApiMock } from '@renderer/test/rendererTestUtils'
import { useUpdateListener } from './useUpdateListener'

vi.mock('sonner', () => ({
  toast: { message: vi.fn(), success: vi.fn(), loading: vi.fn(), error: vi.fn() }
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

type Action = { label: string; onClick: (event: { preventDefault: () => void }) => void }

function setup(): { emit: (state: unknown) => void; invoke: ReturnType<typeof vi.fn> } {
  let listener: ((state: unknown) => void) | undefined
  const invoke = vi.fn().mockResolvedValue({ success: true, data: undefined })
  const api = makeApiMock(invoke)
  api.on.mockImplementation((_channel, callback) => {
    listener = callback
    return () => undefined
  })
  vi.stubGlobal('api', api)
  renderHook(() => useUpdateListener())
  return { emit: (state) => listener?.(state), invoke }
}

function actionOf(fn: unknown, call = 0): Action {
  const options = vi.mocked(fn as typeof toast.message).mock.calls[call][1] as { action: Action }
  return options.action
}

describe('useUpdateListener', () => {
  it('keeps update toasts open until closed and offers an Update action', () => {
    // covers: Test-209
    const { emit } = setup()

    emit({ status: 'available', currentVersion: '1.0.5', availableVersion: '1.0.6' })
    emit({ status: 'ready', currentVersion: '1.0.5', availableVersion: '1.0.6' })

    for (const fn of [toast.message, toast.success]) {
      const [text, options] = vi.mocked(fn).mock.calls[0]
      expect(text).toContain('1.0.6')
      // 저절로 사라지지 않고 닫기(X)로만 사라진다. 같은 자리에서 교체되도록 id를 공유한다.
      expect(options).toMatchObject({ duration: Infinity, id: 'app-update' })
      expect(actionOf(fn).label).toBe('Update')
    }
  })

  it('downloads from the available toast and keeps it open showing progress', () => {
    const { emit, invoke } = setup()
    emit({ status: 'available', currentVersion: '1.0.5', availableVersion: '1.0.6' })

    const preventDefault = vi.fn()
    actionOf(toast.message).onClick({ preventDefault })

    expect(preventDefault).toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('update:download')
    emit({ status: 'downloading', currentVersion: '1.0.5', progressPercent: 42.4 })
    const [text, options] = vi.mocked(toast.loading).mock.calls.at(-1) ?? []
    expect(text).toBe('Downloading 42%')
    // 다운로드 중에는 업데이트 버튼이 남아 있으면 안 된다.
    expect(options).toMatchObject({ id: 'app-update', duration: Infinity })
    expect(options).toHaveProperty('action', undefined)
  })

  it('installs from the ready toast', () => {
    const { emit, invoke } = setup()
    emit({ status: 'ready', currentVersion: '1.0.5', availableVersion: '1.0.6' })

    actionOf(toast.success).onClick({ preventDefault: vi.fn() })

    expect(invoke).toHaveBeenCalledWith('update:install')
  })

  it('stays quiet for states with nothing to announce and for repeats', () => {
    const { emit } = setup()
    // 알릴 것이 없는 상태는 조용해야 한다. 이 단언이 없으면 분기 조건을 상수로 바꿔도
    // 통과해, 사용자가 확인·다운로드 중에도 토스트를 맞는 구현이 그대로 살아남는다.
    for (const status of ['idle', 'checking', 'downloading', 'up-to-date', 'error'] as const) {
      emit({ status, currentVersion: '1.0.5' })
    }
    // 자동 업데이트 중에는 곧바로 다운로드가 이어지므로 'available'도 조용해야 한다.
    emit({
      status: 'available',
      currentVersion: '1.0.5',
      availableVersion: '1.0.7',
      autoUpdate: true
    })
    // 같은 소식이 다시 와도(주기 확인 등) 한 번만 알린다.
    emit({ status: 'ready', currentVersion: '1.0.5', availableVersion: '1.0.6' })
    emit({ status: 'ready', currentVersion: '1.0.5', availableVersion: '1.0.6' })

    expect(toast.message).not.toHaveBeenCalled()
    expect(toast.loading).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledTimes(1)
  })
})
