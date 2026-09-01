import { describe, it, expect, beforeEach } from 'vitest'
import { useContextMenuStore, CONTEXT_MENU_OWNERS } from './useContextMenuStore'

describe('useContextMenuStore', () => {
  beforeEach(() => {
    // 모듈 싱글턴이라 명시적으로 초기 상태로 되돌리지 않으면 Test-220이 실행 순서에
    // 따라 통과/실패한다(useLocalFsStore.test.ts의 리셋 패턴을 따른다).
    useContextMenuStore.setState({ ownerId: null })
  })

  it('has no owner initially', () => {
    // covers: Test-220
    // beforeEach가 setState({ ownerId: null })로 리셋하므로 getState()를 단언하면
    // beforeEach의 인자를 확인하는 자기충족 단언이 된다(스토어를 잘못 초기화해도
    // 통과한다). getInitialState()는 리셋과 무관하게 원본 초기값을 읽는다.
    expect(useContextMenuStore.getInitialState().ownerId).toBeNull()
  })

  it('claims ownership for the caller when opened', () => {
    // covers: Test-221
    useContextMenuStore.getState().open(CONTEXT_MENU_OWNERS.localList)

    expect(useContextMenuStore.getState().ownerId).toBe(CONTEXT_MENU_OWNERS.localList)
  })

  it('transfers ownership to the latest caller, leaving only one owner', () => {
    // covers: Test-222
    useContextMenuStore.getState().open(CONTEXT_MENU_OWNERS.localList)
    useContextMenuStore.getState().open(CONTEXT_MENU_OWNERS.remoteList)

    expect(useContextMenuStore.getState().ownerId).toBe(CONTEXT_MENU_OWNERS.remoteList)
  })

  it('releases ownership when the current owner closes', () => {
    // covers: Test-223
    useContextMenuStore.getState().open(CONTEXT_MENU_OWNERS.localList)
    useContextMenuStore.getState().close(CONTEXT_MENU_OWNERS.localList)

    expect(useContextMenuStore.getState().ownerId).toBeNull()
  })

  it('ignores close from a non-owner, keeping the current owner (E3 race guard)', () => {
    // covers: Test-224
    // Test-224가 없으면 "무조건 null로 만드는" close 구현이 Test-223을 통과해버린다.
    useContextMenuStore.getState().open(CONTEXT_MENU_OWNERS.remoteList)
    useContextMenuStore.getState().close(CONTEXT_MENU_OWNERS.localList)

    expect(useContextMenuStore.getState().ownerId).toBe(CONTEXT_MENU_OWNERS.remoteList)
  })
})
