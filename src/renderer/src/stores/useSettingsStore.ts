import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ThemeSetting } from '@shared/constants'
import type { LanguageSetting } from '@renderer/i18n'
import type { ConflictDecision } from '@shared/types/transfer'
import { TILE_DEFAULT } from '@renderer/lib/explorerLayout'
import { clampTileSize } from '@renderer/lib/gridGeometry'

interface SettingsStore {
  /** 새 탭의 보기(D16). 탭마다 자기 보기를 가진다. */
  viewMode: 'grid' | 'list'
  /** 그리드 타일 크기(px), 8px 단계 96–280 */
  tileSize: number
  showHidden: boolean
  confirmBeforeDelete: boolean
  language: LanguageSetting
  /** 앱 테마(D33). 바뀌면 useThemeSource가 main에 알린다 */
  theme: ThemeSetting
  /** 충돌 시트에서 "지금 결정 기억하기"로 기억한 결정. 다음 시트가 이것을 미리 고른다. 없으면 `null` */
  conflictChoice: ConflictDecision | null

  setViewMode: (mode: 'grid' | 'list') => void
  setTileSize: (size: number) => void
  adjustTileSize: (delta: number) => void
  setShowHidden: (show: boolean) => void
  setConfirmBeforeDelete: (confirm: boolean) => void
  setLanguage: (language: LanguageSetting) => void
  setTheme: (theme: ThemeSetting) => void
  setConflictChoice: (choice: ConflictDecision | null) => void
  /** 모든 설정을 초기값으로(S7): 타일·기본 보기·숨김·삭제 확인·언어·테마·기억한 충돌 결정. 열려 있는 탭의 보기는 그대로다(함정 D). */
  reset: () => void
}

/** v1에만 있던 필드. 두 패널의 보기와 갤러리 썸네일 크기다. */
interface SettingsV1 {
  remoteViewMode?: 'list' | 'grid' | 'gallery'
  localViewMode?: 'list' | 'grid' | 'gallery'
  galleryThumbSize?: number
}

/**
 * v1 → v2: 새 탭의 보기(`viewMode`)는 v1 원격 보기에서 가져오고(`gallery`·`grid` → `grid`)
 * `tileSize`를 더한다. 두 패널의 보기와 갤러리 크기는 버린다.
 */
export function migrateSettings(persisted: unknown, version: number): Partial<SettingsStore> {
  const state = { ...((persisted ?? {}) as Partial<SettingsStore> & SettingsV1) }
  if (version >= 2) return state
  const viewMode = state.remoteViewMode === 'list' ? 'list' : 'grid'
  delete state.remoteViewMode
  delete state.localViewMode
  delete state.galleryThumbSize
  return { ...state, viewMode, tileSize: TILE_DEFAULT }
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      viewMode: 'grid',
      tileSize: TILE_DEFAULT,
      showHidden: false,
      confirmBeforeDelete: true,
      language: 'system',
      theme: 'system',
      conflictChoice: null,

      setViewMode: (mode) => set({ viewMode: mode }),
      setTileSize: (size) => set({ tileSize: clampTileSize(size) }),
      adjustTileSize: (delta) => set((s) => ({ tileSize: clampTileSize(s.tileSize + delta) })),
      setShowHidden: (show) => set({ showHidden: show }),
      setConfirmBeforeDelete: (confirm) => set({ confirmBeforeDelete: confirm }),
      setLanguage: (language) => set({ language }),
      setTheme: (theme) => set({ theme }),
      setConflictChoice: (conflictChoice) => set({ conflictChoice }),
      // persist 옵션(name·version·migrate)은 건드리지 않는다(함정 E).
      reset: () =>
        set({
          viewMode: 'grid',
          tileSize: TILE_DEFAULT,
          showHidden: false,
          confirmBeforeDelete: true,
          language: 'system',
          theme: 'system',
          conflictChoice: null
        })
    }),
    {
      name: 'ftp-browser-settings',
      version: 2,
      migrate: migrateSettings
    }
  )
)
