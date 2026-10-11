import { ipcMain, nativeTheme } from 'electron'
import { THEME_SETTINGS, type ThemeSetting } from '@shared/constants'
import type { IpcResult } from '@shared/types/ipc'

export function registerAppHandlers(): void {
  // themeSource를 바꾸면 렌더러의 prefers-color-scheme과 기본 컨트롤이 함께 따라 바뀐다
  ipcMain.handle('app:setTheme', (_event, theme: unknown): IpcResult<void> => {
    if (!THEME_SETTINGS.includes(theme as ThemeSetting)) {
      return { success: false, error: `Unknown theme: ${String(theme)}` }
    }
    nativeTheme.themeSource = theme as ThemeSetting
    return { success: true, data: undefined }
  })
}
