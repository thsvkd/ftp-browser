import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// devtools.ts imports Menu/screen from electron; mock them so the module loads under node.
vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: vi.fn((template: unknown[]) => ({ popup: vi.fn(), template }))
  },
  screen: {
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 }))
  }
}))

import { Menu, screen } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  matchDebugShortcut,
  cursorToContentPoint,
  registerDevtools,
  type ShortcutInput
} from './devtools'

/**
 * before-input-event가 넘겨주는 Input 객체의 기본 형태.
 * `code` 기본값은 빈 문자열 — 이 픽스처가 물리 키를 특정하지 않는다는 뜻이다.
 * `key` 기준으로 매칭하는 기존 케이스(F12·Ctrl+Shift+C)는 그대로 통과한다.
 */
function keyInput(overrides: Partial<ShortcutInput> = {}): ShortcutInput {
  return {
    type: 'keyDown',
    key: 'a',
    code: '',
    control: false,
    shift: false,
    alt: false,
    meta: false,
    isAutoRepeat: false,
    ...overrides
  }
}

/** Ctrl+Shift+C */
function chord(overrides: Partial<ShortcutInput> = {}): ShortcutInput {
  return keyInput({ key: 'C', control: true, shift: true, ...overrides })
}

/** macOS 관례 조합 Cmd+Option+<key>. `key` 기준이므로 win32 케이스에만 쓴다. */
function macChord(key: string, overrides: Partial<ShortcutInput> = {}): ShortcutInput {
  return keyInput({ key, meta: true, alt: true, ...overrides })
}

/**
 * macOS 관례 조합 Cmd+Option+<물리 키>. D11에 따라 매칭은 `code`로 한다.
 *
 * `key`는 keyInput의 기본값('a')을 그대로 둔다 — 일부러 `'i'`·`'c'`가 아닌 값이라
 * `key` 기준으로 매칭하는 구현은 이 헬퍼를 쓰는 케이스를 통과할 수 없다.
 * 실기에서 오는 실제 글리프 값은 Test-165·166이 따로 고정한다.
 */
function macCodeChord(code: string, overrides: Partial<ShortcutInput> = {}): ShortcutInput {
  return keyInput({ code, meta: true, alt: true, ...overrides })
}

describe('matchDebugShortcut', () => {
  it('should map F12 keyDown to toggle-devtools', () => {
    // covers: Test-5
    expect(matchDebugShortcut(keyInput({ key: 'F12' }), 'win32')).toBe('toggle-devtools')
  })

  it('should map Ctrl+Shift+C to inspect-element', () => {
    // covers: Test-6
    expect(matchDebugShortcut(chord(), 'win32')).toBe('inspect-element')
  })

  it('should map Ctrl+Shift+c (lowercase) to inspect-element', () => {
    // covers: Test-7
    expect(matchDebugShortcut(chord({ key: 'c' }), 'win32')).toBe('inspect-element')
  })

  it('should ignore keyUp so one keypress does not fire twice', () => {
    // covers: Test-8
    expect(matchDebugShortcut(chord({ type: 'keyUp' }), 'win32')).toBeNull()
    expect(matchDebugShortcut(keyInput({ type: 'keyUp', key: 'F12' }), 'win32')).toBeNull()
  })

  it('should require both Control and Shift for inspect-element', () => {
    // covers: Test-9
    expect(matchDebugShortcut(keyInput({ key: 'C', shift: true }), 'win32')).toBeNull()
    expect(matchDebugShortcut(keyInput({ key: 'C', control: true }), 'win32')).toBeNull()
  })

  it('should reject extra modifiers on the inspect-element chord', () => {
    // covers: Test-10
    expect(matchDebugShortcut(chord({ alt: true }), 'win32')).toBeNull()
    expect(matchDebugShortcut(chord({ meta: true }), 'win32')).toBeNull()
  })

  it('should return null for unrelated keys', () => {
    // covers: Test-11
    expect(matchDebugShortcut(keyInput({ key: 'A' }), 'win32')).toBeNull()
    expect(matchDebugShortcut(keyInput({ key: 'Enter' }), 'win32')).toBeNull()
    expect(matchDebugShortcut(keyInput({ key: 'F11' }), 'win32')).toBeNull()
    expect(matchDebugShortcut(chord({ key: 'x' }), 'win32')).toBeNull()
  })

  it('should ignore auto-repeated keys so holding the chord does not storm', () => {
    // covers: Test-35
    expect(matchDebugShortcut(chord({ isAutoRepeat: true }), 'win32')).toBeNull()
    expect(matchDebugShortcut(keyInput({ key: 'F12', isAutoRepeat: true }), 'win32')).toBeNull()
  })
})

// B그룹: 플랫폼 인자에 따른 분기. D8 — macOS는 Cmd+Option 조합을 **추가**할 뿐
// 기존 F12·Ctrl+Shift+C를 제거하지 않으며, Windows 경로에는 회귀가 없다.
describe('matchDebugShortcut — platform-specific chords', () => {
  it('should map Cmd+Option+KeyI to toggle-devtools on macOS', () => {
    // covers: Test-126
    // D11: Option은 glyph modifier라 `key`에 레이아웃 문자가 남는다. 물리 키 위치인
    // `code`로 매칭해야 레이아웃·IME와 무관해진다.
    expect(matchDebugShortcut(macCodeChord('KeyI'), 'darwin')).toBe('toggle-devtools')
  })

  it('should map Cmd+Option+KeyC to inspect-element on macOS', () => {
    // covers: Test-127
    expect(matchDebugShortcut(macCodeChord('KeyC'), 'darwin')).toBe('inspect-element')
  })

  it('should still map F12 to toggle-devtools on macOS', () => {
    // covers: Test-128
    expect(matchDebugShortcut(keyInput({ key: 'F12' }), 'darwin')).toBe('toggle-devtools')
  })

  it('should still map Ctrl+Shift+C to inspect-element on macOS', () => {
    // covers: Test-129
    expect(matchDebugShortcut(chord(), 'darwin')).toBe('inspect-element')
  })

  it('should not map Cmd+Option+I on Windows', () => {
    // covers: Test-130
    expect(matchDebugShortcut(macChord('i'), 'win32')).toBeNull()
  })

  it('should not map Cmd+Option+C on Windows', () => {
    // covers: Test-131
    expect(matchDebugShortcut(macChord('c'), 'win32')).toBeNull()
  })

  it('should keep mapping F12 to toggle-devtools on Windows', () => {
    // covers: Test-132
    expect(matchDebugShortcut(keyInput({ key: 'F12' }), 'win32')).toBe('toggle-devtools')
  })

  it('should keep mapping Ctrl+Shift+C to inspect-element on Windows', () => {
    // covers: Test-133
    expect(matchDebugShortcut(chord(), 'win32')).toBe('inspect-element')
  })

  it('should require Option alongside Cmd on macOS', () => {
    // covers: Test-134
    expect(matchDebugShortcut(keyInput({ code: 'KeyI', meta: true }), 'darwin')).toBeNull()
  })

  it('should require Cmd alongside Option on macOS', () => {
    // covers: Test-135
    expect(matchDebugShortcut(keyInput({ code: 'KeyI', alt: true }), 'darwin')).toBeNull()
  })

  it('should ignore keyUp and auto-repeat for the macOS chord too', () => {
    // covers: Test-136
    expect(matchDebugShortcut(macCodeChord('KeyI', { type: 'keyUp' }), 'darwin')).toBeNull()
    expect(matchDebugShortcut(macCodeChord('KeyI', { isAutoRepeat: true }), 'darwin')).toBeNull()
  })

  it('should map Cmd+Option+KeyI even when the layout yields a dead key', () => {
    // covers: Test-165
    // US 배열에서 Option+I는 dead key(ˆ)다. `key` 기준 구현은 여기서 죽는다.
    expect(matchDebugShortcut(macCodeChord('KeyI', { key: 'ˆ' }), 'darwin')).toBe('toggle-devtools')
  })

  it('should map Cmd+Option+KeyC even when the layout yields a cedilla', () => {
    // covers: Test-166
    // US 배열에서 Option+C는 'ç'다.
    expect(matchDebugShortcut(macCodeChord('KeyC', { key: 'ç' }), 'darwin')).toBe('inspect-element')
  })

  it('should reject the macOS chord when Ctrl is also held', () => {
    // covers: Test-167
    // Ctrl+Shift+C 분기가 `!alt && !meta`로 엄격한 것과 대칭을 맞춘다.
    expect(matchDebugShortcut(macCodeChord('KeyI', { control: true }), 'darwin')).toBeNull()
  })
})

describe('cursorToContentPoint', () => {
  const bounds = { x: 100, y: 50, width: 800, height: 600 }

  it('should convert a screen point inside the content area to content coordinates', () => {
    // covers: Test-12
    expect(cursorToContentPoint({ x: 500, y: 300 }, bounds)).toEqual({ x: 400, y: 250 })
  })

  it('should include the content origin as an inside point', () => {
    // covers: Test-13
    expect(cursorToContentPoint({ x: 100, y: 50 }, bounds)).toEqual({ x: 0, y: 0 })
  })

  it('should return null for points outside the content area', () => {
    // covers: Test-14
    expect(cursorToContentPoint({ x: 99, y: 300 }, bounds)).toBeNull() // left
    expect(cursorToContentPoint({ x: 500, y: 49 }, bounds)).toBeNull() // above
    expect(cursorToContentPoint({ x: 901, y: 300 }, bounds)).toBeNull() // right
    expect(cursorToContentPoint({ x: 500, y: 651 }, bounds)).toBeNull() // below
  })

  it('should treat the far edges as outside (exclusive bounds)', () => {
    // covers: Test-15
    expect(cursorToContentPoint({ x: 900, y: 300 }, bounds)).toBeNull()
    expect(cursorToContentPoint({ x: 500, y: 650 }, bounds)).toBeNull()
  })
})

type Listener = (...args: unknown[]) => void
type Mock = ReturnType<typeof vi.fn>

interface FakeWindowOptions {
  /** DevTools 프론트엔드가 아예 붙지 않은 상태 */
  noDevToolsWebContents?: boolean
  executeJavaScript?: Mock
  devToolsOpened?: boolean
  /** true면 'devtools-opened'를 테스트가 openDevtoolsNow()로 직접 발생시킨다 */
  manualOpen?: boolean
  /** 함수를 주면 호출 시점마다 파괴 여부를 다시 묻는다 (도중 파괴 재현용) */
  destroyed?: boolean | (() => boolean)
}

interface FakeWebContents {
  on: Mock
  once: Mock
  removeListener: Mock
  toggleDevTools: Mock
  openDevTools: Mock
  isDevToolsOpened: Mock
  isDestroyed: Mock
  inspectElement: Mock
  devToolsWebContents: { executeJavaScript: Mock } | null
}

interface FakeWindow {
  win: { webContents: FakeWebContents; getContentBounds: Mock }
  webContents: FakeWebContents
  executeJavaScript: Mock
  emit: (event: string, ...args: unknown[]) => void
  /** manualOpen 모드에서 'devtools-opened'를 발생시킨다 */
  openDevtoolsNow: () => void
}

const CONTENT_BOUNDS = { x: 100, y: 50, width: 800, height: 600 }
/** 콘텐츠 안쪽 {500,300} → 콘텐츠 좌표 {400,250} */
const INSIDE_CURSOR = { x: 500, y: 300 }
const OUTSIDE_CURSOR = { x: 20, y: 20 }

function createFakeWindow(options: FakeWindowOptions = {}): FakeWindow {
  const handlers = new Map<string, Listener[]>()
  const onceHandlers = new Map<string, Listener[]>()
  let devToolsOpened = options.devToolsOpened ?? false

  const executeJavaScript = options.executeJavaScript ?? vi.fn(async () => true)

  const fireOnce = (event: string): void => {
    const list = onceHandlers.get(event) ?? []
    onceHandlers.delete(event)
    for (const fn of list) fn()
  }

  const completeOpen = (): void => {
    devToolsOpened = true
    fireOnce('devtools-opened')
  }

  const webContents: FakeWebContents = {
    on: vi.fn((event: string, fn: Listener) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
    }),
    once: vi.fn((event: string, fn: Listener) => {
      onceHandlers.set(event, [...(onceHandlers.get(event) ?? []), fn])
    }),
    removeListener: vi.fn((event: string, fn: Listener) => {
      const remaining = (onceHandlers.get(event) ?? []).filter((l) => l !== fn)
      onceHandlers.set(event, remaining)
    }),
    toggleDevTools: vi.fn(() => {
      devToolsOpened = !devToolsOpened
    }),
    openDevTools: vi.fn(() => {
      // Electron opens asynchronously: isDevToolsOpened() stays false until the
      // window actually appears. Flipping it synchronously here would hide both
      // the open→inspect ordering and the repeat-keystroke storm.
      if (!options.manualOpen) setTimeout(completeOpen, 0)
    }),
    isDevToolsOpened: vi.fn(() => devToolsOpened),
    isDestroyed: vi.fn(() =>
      typeof options.destroyed === 'function' ? options.destroyed() : (options.destroyed ?? false)
    ),
    inspectElement: vi.fn(),
    devToolsWebContents: options.noDevToolsWebContents ? null : { executeJavaScript }
  }

  const win = {
    webContents,
    getContentBounds: vi.fn(() => ({ ...CONTENT_BOUNDS }))
  }

  return {
    win,
    webContents,
    executeJavaScript,
    emit: (event, ...args) => {
      for (const fn of handlers.get(event) ?? []) fn(...args)
    },
    openDevtoolsNow: completeOpen
  }
}

function makeEvent(): { preventDefault: Mock } {
  return { preventDefault: vi.fn() }
}

function register(win: FakeWindow['win'], debugEnabled: boolean): void {
  registerDevtools(win as unknown as BrowserWindow, debugEnabled, 'win32')
}

/**
 * 타이머와 마이크로태스크를 진행시켜 등록된 비동기 작업을 끝낸다.
 * 기본값은 프론트엔드 재시도(10 x 100ms)와 오픈 타임아웃(2000ms)을 모두 덮는다.
 */
async function settle(ms = 3500): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('registerDevtools', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(Menu.buildFromTemplate).mockClear()
    vi.mocked(screen.getCursorScreenPoint).mockReturnValue({ ...INSIDE_CURSOR })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should not register any listener when debug is disabled', () => {
    // covers: Test-16
    const { win, webContents } = createFakeWindow()
    register(win, false)
    expect(webContents.on).not.toHaveBeenCalled()
  })

  it('should toggle devtools and swallow the event on F12', () => {
    // covers: Test-17
    const { win, webContents, emit } = createFakeWindow()
    register(win, true)
    const event = makeEvent()

    emit('before-input-event', event, keyInput({ key: 'F12' }))

    expect(webContents.toggleDevTools).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('should open devtools and wait for them before entering inspect mode', async () => {
    // covers: Test-18
    const { win, webContents, executeJavaScript, emit, openDevtoolsNow } = createFakeWindow({
      devToolsOpened: false,
      manualOpen: true
    })
    register(win, true)

    emit('before-input-event', makeEvent(), chord())
    await settle(0)

    expect(webContents.openDevTools).toHaveBeenCalledTimes(1)
    // The frontend must not be scripted until DevTools report as open.
    expect(executeJavaScript).not.toHaveBeenCalled()

    openDevtoolsNow()
    await settle(0)

    expect(executeJavaScript).toHaveBeenCalledTimes(1)
  })

  it('should enter inspect element mode through the devtools frontend API', async () => {
    // covers: Test-19
    const { win, executeJavaScript, emit } = createFakeWindow({ devToolsOpened: true })
    register(win, true)

    emit('before-input-event', makeEvent(), chord())
    await settle()

    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('DevToolsAPI.enterInspectElementMode()')
    )
  })

  it('should fall back to inspectElement when the frontend API call rejects', async () => {
    // covers: Test-20
    const executeJavaScript = vi.fn(async () => {
      throw new Error('DevToolsAPI is not defined')
    })
    const { win, webContents, emit } = createFakeWindow({ executeJavaScript })
    register(win, true)

    emit('before-input-event', makeEvent(), chord())
    await settle()

    expect(webContents.inspectElement).toHaveBeenCalledWith(400, 250)
  })

  it('should fall back to inspectElement when devToolsWebContents is null', async () => {
    // covers: Test-21
    const { win, webContents, emit } = createFakeWindow({ noDevToolsWebContents: true })
    register(win, true)

    emit('before-input-event', makeEvent(), chord())
    await settle()

    expect(webContents.inspectElement).toHaveBeenCalledWith(400, 250)
  })

  it('should not inspect anything when the cursor is outside the content area', async () => {
    // covers: Test-22
    vi.mocked(screen.getCursorScreenPoint).mockReturnValue({ ...OUTSIDE_CURSOR })
    const { win, webContents, emit } = createFakeWindow({ noDevToolsWebContents: true })
    register(win, true)

    emit('before-input-event', makeEvent(), chord())
    await settle()

    expect(webContents.inspectElement).not.toHaveBeenCalled()
  })

  it('should leave unrelated keystrokes untouched', () => {
    // covers: Test-23
    const { win, webContents, emit } = createFakeWindow()
    register(win, true)
    const event = makeEvent()

    emit('before-input-event', event, keyInput({ key: 'A' }))

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(webContents.toggleDevTools).not.toHaveBeenCalled()
    expect(webContents.openDevTools).not.toHaveBeenCalled()
  })

  it('should pop a native menu whose Inspect item inspects the clicked point', () => {
    // covers: Test-24
    const { win, webContents, emit } = createFakeWindow()
    register(win, true)

    emit('context-menu', makeEvent(), { x: 12, y: 34 })

    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1)
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0]
    const item = template.find((entry) => String(entry.label).includes('Inspect'))
    expect(item).toBeDefined()

    // The menu is useless unless it is actually shown.
    const menu = vi.mocked(Menu.buildFromTemplate).mock.results[0].value as { popup: Mock }
    expect(menu.popup).toHaveBeenCalledWith({ window: win })

    item?.click?.(undefined as never, undefined as never, undefined as never)
    expect(webContents.inspectElement).toHaveBeenCalledWith(12, 34)
  })

  it('should fall back to inspectElement when the frontend API is missing', async () => {
    // covers: Test-34
    // The injected script guards with `typeof DevToolsAPI === 'undefined'`, so a
    // frontend that lacks the internal API resolves false instead of rejecting.
    const executeJavaScript = vi.fn(async () => false)
    const { win, webContents, emit } = createFakeWindow({ executeJavaScript })
    register(win, true)

    emit('before-input-event', makeEvent(), chord())
    await settle()

    expect(executeJavaScript).toHaveBeenCalled()
    expect(webContents.inspectElement).toHaveBeenCalledWith(400, 250)
  })

  it('should fall back when devtools never report as open', async () => {
    // covers: Test-36
    const { win, webContents, emit } = createFakeWindow({
      manualOpen: true,
      noDevToolsWebContents: true
    })
    register(win, true)

    emit('before-input-event', makeEvent(), chord())
    await settle()

    // The open promise timed out instead of hanging forever, so the fallback ran.
    expect(webContents.inspectElement).toHaveBeenCalledWith(400, 250)
  })

  it('should retry until the devtools frontend has finished loading', async () => {
    // covers: Test-37
    // 'devtools-opened' fires before the frontend bundle evaluates, so the first
    // attempts see no DevToolsAPI and resolve false.
    let attempts = 0
    const executeJavaScript = vi.fn(async () => ++attempts >= 3)
    const { win, webContents, emit } = createFakeWindow({ executeJavaScript })
    register(win, true)

    emit('before-input-event', makeEvent(), chord())
    await settle()

    expect(executeJavaScript).toHaveBeenCalledTimes(3)
    expect(webContents.inspectElement).not.toHaveBeenCalled()
  })

  it('should not inspect a destroyed webContents', async () => {
    // covers: Test-39
    const { win, webContents, emit } = createFakeWindow({
      noDevToolsWebContents: true,
      destroyed: true
    })
    register(win, true)

    emit('before-input-event', makeEvent(), chord())
    await settle()

    expect(webContents.inspectElement).not.toHaveBeenCalled()
  })

  it('should not inspect a webContents destroyed while the frontend call was in flight', async () => {
    // covers: Test-41
    // Closing the window during the executeJavaScript round trip is the case the
    // early return cannot cover — the check has to happen after the await too.
    let destroyed = false
    const executeJavaScript = vi.fn(async () => {
      destroyed = true
      return false
    })
    const { win, webContents, emit } = createFakeWindow({
      executeJavaScript,
      destroyed: () => destroyed
    })
    register(win, true)

    emit('before-input-event', makeEvent(), chord())
    await settle()

    expect(executeJavaScript).toHaveBeenCalled()
    expect(webContents.inspectElement).not.toHaveBeenCalled()
  })

  it('should collapse repeated chords while one inspect is still in flight', async () => {
    // covers: Test-40
    const { win, webContents, emit } = createFakeWindow({ manualOpen: true })
    register(win, true)

    emit('before-input-event', makeEvent(), chord())
    emit('before-input-event', makeEvent(), chord())
    emit('before-input-event', makeEvent(), chord())
    await settle(0)

    expect(webContents.openDevTools).toHaveBeenCalledTimes(1)
  })
})
