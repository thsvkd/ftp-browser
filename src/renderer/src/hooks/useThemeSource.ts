import { useEffect } from 'react'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'

/** 저장된 테마를 시작할 때와 바뀔 때 main에 보낸다(D33). main의 nativeTheme이 화면 전체를 바꾼다. */
export function useThemeSource(): void {
  const theme = useSettingsStore((s) => s.theme)
  useEffect(() => {
    void window.api.invoke('app:setTheme', theme)
  }, [theme])
}
