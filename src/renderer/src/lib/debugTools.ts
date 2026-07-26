/**
 * Whether a right-click should be handed to Electron's native context menu
 * (which carries "Inspect Element" while debugging) instead of the app's own.
 *
 * Chromium never forwards a contextmenu event to the main process once the
 * renderer calls `preventDefault()`, so views with a custom menu would other-
 * wise have no way to reach the inspector. Shift+right-click is the same escape
 * hatch Chrome offers on pages that hijack the context menu.
 */
export function shouldDeferToNativeContextMenu(
  event: { shiftKey: boolean },
  debugEnabled: boolean
): boolean {
  return debugEnabled && event.shiftKey
}
