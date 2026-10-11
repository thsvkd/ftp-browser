/**
 * 렌더러 컴포넌트 테스트들이 공유하는 목·조회 헬퍼.
 *
 * 핸드오프 3절이 기각한 것은 **컴포넌트** 공용화이며, 그 사유(스토어가 다름, 경로 규칙이
 * POSIX 고정 vs OS 감지, 전송 방향이 반대)는 여기 헬퍼들엔 하나도 해당하지 않는다.
 * 이들은 패널과 무관한 테스트 인프라라 중복시킬 이유가 없다.
 */
import { vi, type Mock } from 'vitest'

/** preload가 없는 테스트 환경에 주입하는 `window.api` 목. */
export interface ApiMock {
  invoke: Mock
  on: Mock
  getPathForFile: Mock
  debugToolsEnabled: boolean
  platform: string
}

/**
 * `debugToolsEnabled`·`platform`은 이벤트 시점에 읽히므로, 반환된 객체를 테스트에서
 * 그대로 변경해 debug 모드나 플랫폼을 바꿀 수 있다(재stub 불필요).
 *
 * `platform` 기본값이 `'win32'`인 이유: 기존 컴포넌트 테스트들이 Windows 동작을
 * 전제로 작성돼 있다. 기본값을 바꾸면 이번 범위와 무관한 테스트가 무더기로 깨지고,
 * 그 실패는 회귀가 아니라 목 설정 변경의 부작용이라 신호가 오염된다(핸드오프 §4).
 */
export function makeApiMock(invoke: Mock): ApiMock {
  return {
    invoke,
    on: vi.fn(() => () => undefined),
    getPathForFile: vi.fn(() => ''),
    debugToolsEnabled: false,
    platform: 'win32'
  }
}

/** 해당 IPC 채널로 호출된 인자 목록(채널명은 제외). */
export function invokeCalls(invoke: Mock, channel: string): unknown[][] {
  return invoke.mock.calls.filter((call) => call[0] === channel).map((call) => call.slice(1))
}

/**
 * 메뉴 위치 보정(D6: useLayoutEffect + ref 실측)을 검증하기 위해 메뉴 크기와 뷰포트
 * 크기를 고정한다. jsdom은 레이아웃을 계산하지 않아 getBoundingClientRect가 항상
 * 0을 반환하므로, 이를 목해 실측 결과를 결정론적으로 만든다.
 *
 * `setMenuSize`로 렌더 도중 크기를 바꿀 수 있다(예: editing 전환 시 입력창 한 줄로
 * 줄어드는 것을 흉내). 크기를 고정 상수로 두면 "매번 다시 측정하는" 구현과
 * "크기를 아예 하드코딩한" 구현을 구분하지 못하므로(핸드오프 §1), 매 호출마다
 * 현재 크기를 다시 읽도록 클로저로 구현한다. `restore`를 afterEach에서 호출해
 * 원래 디스크립터로 되돌린다.
 */
export function stubMenuViewport(
  menuSize: { width: number; height: number },
  viewport: { width: number; height: number }
): {
  setMenuSize: (size: { width: number; height: number }) => void
  restore: () => void
} {
  const rectDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'getBoundingClientRect'
  )
  const widthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  const heightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight')

  let currentSize = menuSize

  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: currentSize.width,
      bottom: currentSize.height,
      width: currentSize.width,
      height: currentSize.height,
      toJSON: () => ({})
    })
  })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewport.width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewport.height })

  return {
    setMenuSize: (size) => {
      currentSize = size
    },
    restore: () => {
      if (rectDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', rectDescriptor)
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect')
      }
      if (widthDescriptor) {
        Object.defineProperty(window, 'innerWidth', widthDescriptor)
      } else {
        Reflect.deleteProperty(window, 'innerWidth')
      }
      if (heightDescriptor) {
        Object.defineProperty(window, 'innerHeight', heightDescriptor)
      } else {
        Reflect.deleteProperty(window, 'innerHeight')
      }
    }
  }
}

const GRID_LAYOUT_PROPS = [
  'clientWidth',
  'clientHeight',
  'offsetWidth',
  'offsetHeight',
  'getBoundingClientRect'
] as const

/**
 * jsdom은 레이아웃을 계산하지 않아 스크롤 컨테이너 크기가 0이고, 그러면 TanStack Virtual이
 * 아무 행도 렌더하지 않는다(실측: 스텁 없이는 컨테이너가 자식 없이 비어 있어 셀을 찾지 못한다).
 * 셀을 조작하려면 실제 크기가 필요하므로 채워 넣고, 다른 테스트 파일로 새지 않도록
 * 원본 디스크립터를 저장해 두었다가 `restore`로 되돌린다.
 */
export function stubGridLayout(): { restore: () => void } {
  const saved: Array<[string, PropertyDescriptor | undefined]> = GRID_LAYOUT_PROPS.map((prop) => [
    prop,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)
  ])

  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1200,
    bottom: 800,
    width: 1200,
    height: 800,
    toJSON: () => ({})
  }
  const values: Record<string, unknown> = {
    clientWidth: 1200,
    clientHeight: 800,
    offsetWidth: 1200,
    offsetHeight: 800,
    getBoundingClientRect: () => rect
  }
  for (const prop of GRID_LAYOUT_PROPS) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      value: values[prop]
    })
  }

  return {
    restore: () => {
      for (const [prop, descriptor] of saved) {
        if (descriptor) {
          Object.defineProperty(HTMLElement.prototype, prop, descriptor)
        } else {
          Reflect.deleteProperty(HTMLElement.prototype, prop)
        }
      }
    }
  }
}
