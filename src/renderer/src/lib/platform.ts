/**
 * Platform-aware modifier rules for the renderer.
 *
 * Ctrl+click is the secondary click on macOS, so reading it as a
 * selection toggle flips the selection while the context menu opens. The
 * predicates below are pure and take the platform as an argument so both
 * branches are reachable from one test suite; the views pass
 * `currentPlatform()`, which reads the value preload hands over.
 */

/** The parts of a mouse/wheel event the modifier predicates read. */
export interface ModifierState {
  ctrlKey: boolean
  metaKey: boolean
}

/** Whether `platform` is macOS. */
export function isMac(platform: string): boolean {
  return platform === 'darwin'
}

/** The platform preload exposed, or an empty string when preload is absent. */
export function currentPlatform(): string {
  // An empty string falls back to "not macOS", which is the pre-existing behavior.
  return window.api?.platform ?? ''
}

/** Whether the held modifiers mean "toggle this item's selection". */
export function isToggleSelectModifier(event: ModifierState, platform: string): boolean {
  if (isMac(platform)) return event.metaKey
  return event.ctrlKey || event.metaKey
}

/** Whether the held modifiers mean "zoom" for a wheel event. */
export function isZoomModifier(event: ModifierState, platform: string): boolean {
  // Ctrl stays a zoom modifier everywhere: a macOS trackpad pinch arrives as a
  // wheel event with `ctrlKey` set. Meta is only a zoom modifier on macOS,
  // where it is Cmd — on Windows it is the Win key.
  return event.ctrlKey || (isMac(platform) && event.metaKey)
}
