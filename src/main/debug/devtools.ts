import { Menu, screen } from 'electron'
import type { BrowserWindow, Input, WebContents } from 'electron'

type DebugAction = 'toggle-devtools' | 'inspect-element'

/**
 * The parts of Electron's `Input` the shortcut matcher reads.
 *
 * `code` (physical key position) is required alongside `key` because macOS
 * keeps Option in the glyph modifiers: with Cmd+Option held, `key` carries the
 * layout's dead key or accented character (ˆ, ç, or a Hangul jamo), never the
 * plain letter. D11 matches the Cmd+Option chords on `code` for that reason.
 */
export type ShortcutInput = Pick<
  Input,
  'type' | 'key' | 'code' | 'control' | 'shift' | 'alt' | 'meta' | 'isAutoRepeat'
>

interface Point {
  x: number
  y: number
}

interface ContentBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Give up waiting for the DevTools window and try the fallback instead. */
const DEVTOOLS_OPEN_TIMEOUT_MS = 2000

/**
 * `devtools-opened` fires when the DevTools webContents exists, not when its
 * frontend bundle has finished evaluating — and `DevToolsAPI` only exists once
 * it has. Poll briefly rather than inspecting the wrong thing on first press.
 */
const FRONTEND_ATTEMPTS = 10
const FRONTEND_RETRY_MS = 100

/**
 * Runs inside the DevTools frontend. `DevToolsAPI.enterInspectElementMode()` is
 * what Chrome itself calls for Ctrl+Shift+C, but it is an undocumented internal
 * of the frontend bundle — the guard lets us detect its absence and fall back to
 * the public `webContents.inspectElement()` instead of throwing.
 */
const ENTER_INSPECT_MODE_SCRIPT = `(() => {
  if (typeof DevToolsAPI === 'undefined' || !DevToolsAPI.enterInspectElementMode) return false
  DevToolsAPI.enterInspectElementMode()
  return true
})()`

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Map a keystroke to a debug action on `platform`. Only a non-repeating
 * `keyDown` matches: the matching `keyUp` would run the action twice, and
 * holding the chord down would queue one DevTools open per repeat.
 *
 * The platform is injected rather than read from `process.platform` so both
 * branches can be exercised from one test suite.
 */
export function matchDebugShortcut(input: ShortcutInput, platform: string): DebugAction | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return null
  if (input.key === 'F12') return 'toggle-devtools'
  const key = input.key.toLowerCase()
  if (key === 'c' && input.control && input.shift && !input.alt && !input.meta) {
    return 'inspect-element'
  }
  // macOS binds the inspector to Cmd+Option instead, and a MacBook's F12 is a
  // volume key unless `fn` is held. The Windows chords stay recognised on macOS
  // for external keyboards, so this branch only ever adds matches.
  //
  // Matched on `code` rather than `key` (D11): Option is a glyph modifier on
  // macOS, so it rewrites the character even while Cmd is held — `key` arrives
  // as ˆ, ç or a Hangul jamo depending on layout and IME, while `code` is the
  // physical key position and is unaffected. The negative guards mirror the
  // Ctrl+Shift+C branch above, which likewise refuses extra modifiers.
  if (platform === 'darwin' && input.meta && input.alt && !input.control && !input.shift) {
    if (input.code === 'KeyI') return 'toggle-devtools'
    if (input.code === 'KeyC') return 'inspect-element'
  }
  return null
}

/**
 * Convert a screen-space cursor position into content-relative coordinates,
 * or null when the cursor is not over the window's web content.
 */
export function cursorToContentPoint(cursor: Point, bounds: ContentBounds): Point | null {
  const x = cursor.x - bounds.x
  const y = cursor.y - bounds.y
  if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return null
  return { x, y }
}

/**
 * Open the DevTools if needed and wait until they report as open. Resolves on
 * timeout too — a caller that never settles would swallow the keystroke and
 * leak the listener, so a late DevTools is better handled by the fallback.
 */
async function openDevtools(wc: WebContents): Promise<void> {
  if (wc.isDevToolsOpened()) return
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      wc.removeListener('devtools-opened', finish)
      resolve()
    }
    const timer = setTimeout(finish, DEVTOOLS_OPEN_TIMEOUT_MS)
    wc.once('devtools-opened', finish)
    wc.openDevTools()
  })
}

/** Ask the DevTools frontend to enter element-picking mode. */
async function enterInspectMode(wc: WebContents): Promise<boolean> {
  for (let attempt = 0; attempt < FRONTEND_ATTEMPTS; attempt++) {
    if (wc.isDestroyed()) return false
    const devTools = wc.devToolsWebContents
    if (devTools) {
      try {
        if ((await devTools.executeJavaScript(ENTER_INSPECT_MODE_SCRIPT)) === true) return true
      } catch {
        // Frontend still booting, or the internal API moved. Retry, then fall back.
      }
    }
    await delay(FRONTEND_RETRY_MS)
  }
  return false
}

/**
 * Put the DevTools into element-picking mode, falling back to inspecting
 * whatever sits under the cursor when the frontend API is unavailable.
 */
async function inspectElementUnderCursor(win: BrowserWindow): Promise<void> {
  const wc = win.webContents

  // Read the cursor before opening the DevTools: docking them shrinks the
  // content area and would shift the coordinates the fallback relies on.
  const cursorPoint = wc.isDevToolsOpened()
    ? null
    : cursorToContentPoint(screen.getCursorScreenPoint(), win.getContentBounds())

  await openDevtools(wc)
  if (wc.isDestroyed()) return
  if (await enterInspectMode(wc)) return

  // Without a usable cursor position there is nothing meaningful to inspect;
  // leaving the DevTools open is better than picking an arbitrary element.
  if (cursorPoint && !wc.isDestroyed()) wc.inspectElement(cursorPoint.x, cursorPoint.y)
}

/**
 * Wire up the developer shortcuts on `win`. Does nothing unless debug mode is
 * on, so a shipped build without `--devtools` behaves exactly as before.
 *
 * - F12: toggle DevTools.
 * - Ctrl+Shift+C: enter element-picking mode, like the browser shortcut.
 * - Right-click: native "Inspect Element" menu. `ContextMenuParams` carries no
 *   modifier state, so the Shift-only rule is enforced in the renderer, which
 *   `preventDefault()`s every other right-click before it reaches us.
 */
export function registerDevtools(
  win: BrowserWindow,
  debugEnabled: boolean,
  platform: string
): void {
  if (!debugEnabled) return
  const wc = win.webContents
  let inspecting = false

  wc.on('before-input-event', (event, input) => {
    const action = matchDebugShortcut(input, platform)
    if (!action) return
    event.preventDefault()

    if (action === 'toggle-devtools') {
      wc.toggleDevTools()
      return
    }
    if (inspecting) return
    inspecting = true
    void inspectElementUnderCursor(win)
      .catch(() => {
        // The window can go away mid-flight; nothing left to inspect.
      })
      .finally(() => {
        inspecting = false
      })
  })

  wc.on('context-menu', (_event, params) => {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Inspect Element',
        click: () => {
          if (!wc.isDestroyed()) wc.inspectElement(params.x, params.y)
        }
      }
    ])
    menu.popup({ window: win })
  })
}
