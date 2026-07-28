/**
 * 렌더러 컴포넌트 테스트들이 공유하는 목·조회 헬퍼.
 *
 * 핸드오프 3절이 기각한 것은 **컴포넌트** 공용화이며, 그 사유(스토어가 다름, 경로 규칙이
 * POSIX 고정 vs OS 감지, 전송 방향이 반대)는 여기 헬퍼들엔 하나도 해당하지 않는다.
 * 이들은 패널과 무관한 테스트 인프라라 중복시킬 이유가 없다.
 */
import { screen } from '@testing-library/react'
import { vi, type Mock } from 'vitest'
import { useLocalSelectionStore } from '@renderer/stores/useLocalSelectionStore'

/** preload가 없는 테스트 환경에 주입하는 `window.api` 목. */
export interface ApiMock {
  invoke: Mock
  on: Mock
  getPathForFile: Mock
  debugToolsEnabled: boolean
}

/**
 * `debugToolsEnabled`는 이벤트 시점에 읽히므로, 반환된 객체를 테스트에서 그대로
 * 변경해 debug 모드를 켤 수 있다(재stub 불필요).
 */
export function makeApiMock(invoke: Mock): ApiMock {
  return {
    invoke,
    on: vi.fn(() => () => undefined),
    getPathForFile: vi.fn(() => ''),
    debugToolsEnabled: false
  }
}

/** 해당 IPC 채널로 호출된 인자 목록(채널명은 제외). */
export function invokeCalls(invoke: Mock, channel: string): unknown[][] {
  return invoke.mock.calls.filter((call) => call[0] === channel).map((call) => call.slice(1))
}

/**
 * 열려 있는 컨텍스트 메뉴. 메뉴는 선택 상태와 무관하게 항상 New Folder를 가지므로
 * (계약 §6 라벨 표) 이 버튼의 존재를 메뉴의 존재로 삼는다.
 */
export function queryMenu(): HTMLElement | null {
  return screen.queryByRole('button', { name: 'New Folder' })
}

/** 로컬 선택 스토어의 현재 선택(정렬본). */
export function localSelectedNames(): string[] {
  return [...useLocalSelectionStore.getState().selectedNames].sort()
}
