import type { BrowserWindow } from 'electron'

/**
 * On macOS, hide the window when it is closed instead of destroying it.
 *
 * Every IPC handler is registered once, against the first window, for the
 * app's whole lifetime. macOS keeps the app running after its last window
 * closes, and reopening it from the Dock used to create a *second* window the
 * handlers knew nothing about: each event they pushed hit the destroyed one
 * and threw "Object has been destroyed", so connecting failed and transfers
 * never started until the app was restarted. Keeping the one window alive
 * avoids that, and brings the user back to where they left off.
 *
 * `isQuitting` lets a real quit (Cmd+Q, Dock → Quit, logout) close it.
 */
export function hideOnCloseOnMac(
  win: BrowserWindow,
  platform: NodeJS.Platform,
  isQuitting: () => boolean
): void {
  if (platform !== 'darwin') return
  win.on('close', (event) => {
    if (isQuitting()) return
    event.preventDefault()
    // Hiding a full-screen window leaves an empty black Space behind.
    if (win.isFullScreen()) {
      win.once('leave-full-screen', () => win.hide())
      win.setFullScreen(false)
    } else {
      win.hide()
    }
  })
}
