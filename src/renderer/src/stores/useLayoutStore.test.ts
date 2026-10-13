/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLayoutStore } from './useLayoutStore'

const KEY = 'ftp-browser-layout'

afterEach(() => {
  useLayoutStore.setState({
    left: { width: 220, collapsed: false },
    right: { width: 288, collapsed: false },
    priority: null
  })
  localStorage.clear()
})

describe('useLayoutStore', () => {
  it('starts at the default widths, clamps commits, toggles per side and tracks the last touched side', () => {
    // covers: Test-901
    const s = (): ReturnType<typeof useLayoutStore.getState> => useLayoutStore.getState()
    expect(s().left).toEqual({ width: 220, collapsed: false })
    expect(s().right).toEqual({ width: 288, collapsed: false })
    expect(s().priority).toBeNull()

    s().commit('left', { width: 999 })
    expect(s().left.width).toBe(360)
    expect(s().priority).toBe('left')

    s().commit('left', { width: 300 })
    s().toggle('left')
    expect(s().left).toEqual({ width: 300, collapsed: true })
    s().toggle('left')
    expect(s().left).toEqual({ width: 300, collapsed: false })
    expect(s().right).toEqual({ width: 288, collapsed: false })

    s().toggle('right')
    expect(s().priority).toBe('right')
    expect(s().right.collapsed).toBe(true)
    s().commit('right', { width: 400, collapsed: false })
    s().reset('right')
    expect(s().right).toEqual({ width: 288, collapsed: false })
    s().reset('left')
    expect(s().left).toEqual({ width: 220, collapsed: false })
    expect(s().priority).toBe('left')
  })

  it('persists left and right only, repairs stored values and ignores a stored priority', async () => {
    // covers: Test-902
    useLayoutStore.getState().commit('left', { width: 300 })
    useLayoutStore.getState().toggle('right')
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    expect(saved.version).toBe(1)
    expect(saved.state.left.width).toBe(300)
    expect(saved.state.right.collapsed).toBe(true)
    expect(saved.state).not.toHaveProperty('priority')

    useLayoutStore.setState({ priority: null })
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: {
          left: { width: 300, collapsed: true },
          right: { width: 9999, collapsed: 'x' },
          priority: 'left'
        },
        version: 1
      })
    )
    useLayoutStore.persist.rehydrate()
    expect(useLayoutStore.getState().left).toEqual({ width: 300, collapsed: true })
    expect(useLayoutStore.getState().right).toEqual({ width: 480, collapsed: false })
    expect(useLayoutStore.getState().priority).toBeNull()

    // 깨진 JSON을 들고 앱이 새로 뜨면 기본값으로 시작하고, 이어지는 변경이 저장소를 고친다.
    // (rehydrate()는 읽기에 실패하면 메모리 상태를 건드리지 않으므로, 새 모듈로 가른다.)
    localStorage.setItem(KEY, '{')
    vi.resetModules()
    const fresh = (await import('./useLayoutStore')).useLayoutStore
    expect(fresh.getState().left).toEqual({ width: 220, collapsed: false })
    expect(fresh.getState().right).toEqual({ width: 288, collapsed: false })
    fresh.getState().commit('left', { width: 301 })
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{').state.left.width).toBe(301)
  })
})
