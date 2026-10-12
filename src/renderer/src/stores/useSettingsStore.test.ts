/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { migrateSettings, useSettingsStore } from './useSettingsStore'

describe('useSettingsStore migration', () => {
  it('moves v1 settings to v2: grid/gallery → grid, list → list, tile size 160, the rest kept', () => {
    // covers: Test-788
    const kept = { showHidden: true, confirmBeforeDelete: false, language: 'ko' }
    const v1 = { ...kept, remoteViewMode: 'gallery', localViewMode: 'list', galleryThumbSize: 200 }
    expect(migrateSettings(v1, 1)).toEqual({ ...kept, viewMode: 'grid', tileSize: 160 })
    expect(migrateSettings({ ...v1, remoteViewMode: 'grid' }, 1)).toMatchObject({
      viewMode: 'grid'
    })
    expect(migrateSettings({ ...v1, remoteViewMode: 'list' }, 1)).toMatchObject({
      viewMode: 'list'
    })
  })

  it('starts with no remembered conflict choice, keeps one that is set and persists it', () => {
    // covers: Test-1091
    expect(useSettingsStore.getState().conflictChoice).toBeNull()
    useSettingsStore.getState().setConflictChoice('rename')
    expect(useSettingsStore.getState().conflictChoice).toBe('rename')
    const saved = JSON.parse(localStorage.getItem('ftp-browser-settings') ?? '{}')
    expect(saved.state.conflictChoice).toBe('rename')
    // v2 이전 설정에는 이 필드가 없다: 마이그레이션이 만들어 내지 않는다
    expect(migrateSettings({ showHidden: true }, 2)).toEqual({ showHidden: true })
    useSettingsStore.getState().setConflictChoice(null)
    expect(useSettingsStore.getState().conflictChoice).toBeNull()
  })
})
