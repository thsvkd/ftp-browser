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

/** before-input-event가 넘겨주는 Input 객체의 기본 형태 */
function keyInput(overrides: Partial<ShortcutInput> = {}): ShortcutInput {
  return {
    type: 'keyDown',
    key: 'a',
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

describe('matchDebugShortcut', () => {
  it('should map F12 keyDown to toggle-devtools', () => {
    // covers: Test-5
    expect(matchDebugShortcut(keyInput({ key: 'F12' }))).toBe('toggle-devtools')
  })

  it('should map Ctrl+Shift+C to inspect-element', () => {
    // covers: Test-6
    expect(matchDebugShortcut(chord())).toBe('inspect-element')
  })

  it('should map Ctrl+Shift+c (lowercase) to inspect-element', () => {
    // covers: Test-7
    expect(matchDebugShortcut(chord({ key: 'c' }))).toBe('inspect-element')
  })

  it('should ignore keyUp so one keypress does not fire twice', () => {
    // covers: Test-8
    expect(matchDebugShortcut(chord({ type: 'keyUp' }))).toBeNull()
    expect(matchDebugShortcut(keyInput({ type: 'keyUp', key: 'F12' }))).toBeNull()
  })

  it('should require both Control and Shift for inspect-element', () => {
    // covers: Test-9
    expect(matchDebugShortcut(keyInput({ key: 'C', shift: true }))).toBeNull()
    expect(matchDebugShortcut(keyInput({ key: 'C', control: true }))).toBeNull()
  })

  it('should reject extra modifiers on the inspect-element chord', () => {
    // covers: Test-10
    expect(matchDebugShortcut(chord({ alt: true }))).toBeNull()
    expect(matchDebugShortcut(chord({ meta: true }))).toBeNull()
  })

  it('should return null for unrelated keys', () => {
    // covers: Test-11
    expect(matchDebugShortcut(keyInput({ key: 'A' }))).toBeNull()
    expect(matchDebugShortcut(keyInput({ key: 'Enter' }))).toBeNull()
    expect(matchDebugShortcut(keyInput({ key: 'F11' }))).toBeNull()
    expect(matchDebugShortcut(chord({ key: 'x' }))).toBeNull()
  })

  it('should ignore auto-repeated keys so holding the chord does not storm', () => {
    // covers: Test-35
    expect(matchDebugShortcut(chord({ isAutoRepeat: true }))).toBeNull()
    expect(matchDebugShortcut(keyInput({ key: 'F12', isAutoRepeat: true }))).toBeNull()
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
  registerDevtools(win as unknown as BrowserWindow, debugEnabled)
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
