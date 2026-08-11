/** @vitest-environment jsdom */
// currentPlatform()이 window.api를 읽으므로 이 파일만 jsdom이 필요하다.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  currentPlatform,
  isToggleSelectModifier,
  isZoomModifier,
  type ModifierState
} from './platform'

/** 수정자 조합. 나머지는 눌리지 않은 상태다. */
function modifiers(overrides: Partial<ModifierState> = {}): ModifierState {
  return { ctrlKey: false, metaKey: false, ...overrides }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isToggleSelectModifier', () => {
  it('should not treat Ctrl as a selection toggle on macOS', () => {
    // covers: Test-137
    // D7: macOS의 Ctrl+클릭은 보조 클릭이다. 토글로도 읽으면 메뉴와 선택이 함께 움직인다.
    expect(isToggleSelectModifier(modifiers({ ctrlKey: true }), 'darwin')).toBe(false)
  })

  it('should treat Cmd as a selection toggle on macOS', () => {
    // covers: Test-138
    expect(isToggleSelectModifier(modifiers({ metaKey: true }), 'darwin')).toBe(true)
  })

  it('should treat Ctrl as a selection toggle on Windows', () => {
    // covers: Test-139
    expect(isToggleSelectModifier(modifiers({ ctrlKey: true }), 'win32')).toBe(true)
  })

  it('should treat Meta as a selection toggle on Windows', () => {
    // covers: Test-140
    expect(isToggleSelectModifier(modifiers({ metaKey: true }), 'win32')).toBe(true)
  })

  it('should not toggle when no modifier is held on either platform', () => {
    // covers: Test-141
    expect(isToggleSelectModifier(modifiers(), 'darwin')).toBe(false)
    expect(isToggleSelectModifier(modifiers(), 'win32')).toBe(false)
  })
})

describe('currentPlatform', () => {
  it('should return the platform preload exposed', () => {
    // covers: Test-142
    // 값을 그대로 흘려보내는지 보려면 서로 다른 두 값을 확인해야 한다.
    vi.stubGlobal('api', { platform: 'darwin' })
    expect(currentPlatform()).toBe('darwin')

    vi.stubGlobal('api', { platform: 'win32' })
    expect(currentPlatform()).toBe('win32')
  })

  it('should fall back to an empty string when preload is absent', () => {
    // covers: Test-143
    vi.stubGlobal('api', undefined)

    expect(currentPlatform()).toBe('')
  })

  it('should fall back to an empty string when api carries no platform field', () => {
    // covers: Test-164
    // 정정 3: Test-143은 api 객체 자체가 없는 경우만 규정했다. 구버전 preload처럼
    // api는 있는데 필드만 없는 경우도 mac 아님으로 폴백해야 한다.
    vi.stubGlobal('api', { debugToolsEnabled: false })

    expect(currentPlatform()).toBe('')
  })
})

describe('isZoomModifier', () => {
  it('should accept Ctrl on macOS so trackpad pinch keeps zooming', () => {
    // covers: Test-144
    // D9: 트랙패드 핀치는 ctrlKey: true인 wheel 이벤트로 도착한다.
    expect(isZoomModifier(modifiers({ ctrlKey: true }), 'darwin')).toBe(true)
  })

  it('should accept Cmd on macOS for wheel mice', () => {
    // covers: Test-145
    expect(isZoomModifier(modifiers({ metaKey: true }), 'darwin')).toBe(true)
  })

  it('should not accept Meta on Windows', () => {
    // covers: Test-146
    // Windows의 meta는 Win 키라 줌 수정자가 아니다.
    expect(isZoomModifier(modifiers({ metaKey: true }), 'win32')).toBe(false)
  })

  it('should accept Ctrl on Windows', () => {
    // covers: Test-162
    // 정정 1: 기존 그리드 테스트가 Windows Ctrl+휠 줌을 덮는다는 서술은 사실이 아니었다.
    expect(isZoomModifier(modifiers({ ctrlKey: true }), 'win32')).toBe(true)
  })
})
