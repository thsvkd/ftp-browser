import { Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { APP_NAME } from '@shared/constants'

/**
 * The macOS application menu.
 *
 * Every item is a plain role: Electron then supplies the OS-standard
 * accelerator, label and localization, which is what actually revives Cmd+Q,
 * Cmd+W and the clipboard chords once the menu exists at all.
 *
 * The macro roles (`appMenu`, `editMenu`, `windowMenu`, ...) are deliberately
 * avoided. `{ role: 'viewMenu' }` expands at `buildFromTemplate` time into
 * Reload / Force Reload / **Toggle Developer Tools** / Reset Zoom, which would
 * reopen the developer tools without the `--devtools` flag while the template
 * still reads as a single harmless string.
 *
 * macOS titles the first menu after the running application, so its label is
 * never what the user reads. Electron still rejects a template item that
 * declares none of label, role or type, and a throw here means the app never
 * gets a window — hence the shared app name rather than nothing.
 */
const MAC_MENU_TEMPLATE: MenuItemConstructorOptions[] = [
  {
    label: APP_NAME,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' }
    ]
  },
  {
    // `role: 'window'` marks the menu that macOS treats as the Window menu.
    // Unlike `windowMenu` it is not expanded at `buildFromTemplate` time, so it
    // cannot introduce items the template does not name; macOS does append the
    // list of open windows to it at runtime.
    label: 'Window',
    role: 'window',
    submenu: [{ role: 'minimize' }, { role: 'close' }]
  }
]

/**
 * The application menu template for `platform`, or `null` when the platform
 * should have no application menu at all.
 *
 * The platform is injected rather than read from `process.platform` so both
 * branches can be exercised from one test suite.
 */
export function buildAppMenuTemplate(platform: string): MenuItemConstructorOptions[] | null {
  // Windows and Linux never had a menu bar here, and adding one would change
  // the existing UI on those platforms.
  if (platform !== 'darwin') return null
  return MAC_MENU_TEMPLATE
}

/** Install (or clear) the application menu for `platform`. */
export function applyApplicationMenu(platform: string): void {
  const template = buildAppMenuTemplate(platform)
  if (!template) {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
