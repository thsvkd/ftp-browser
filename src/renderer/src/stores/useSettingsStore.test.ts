/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { migrateSettings, useSettingsStore } from './useSettingsStore'
import { TILE_DEFAULT } from '@renderer/lib/explorerLayout'

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

describe('useSettingsStore reset', () => {
  it('returns every setting — tile, default view, hidden, delete confirm, language, theme — to its default', () => {
    // covers: Test-1239
    useSettingsStore.setState({
      viewMode: 'list',
      tileSize: 224,
      showHidden: true,
      confirmBeforeDelete: false,
      language: 'ko',
      theme: 'dark'
    })

    useSettingsStore.getState().reset()

    // 일부만 초기화하는 구현을 막는다(S7): 전부가 동시에 초기값이어야 한다.
    expect(useSettingsStore.getState()).toMatchObject({
      viewMode: 'grid',
      tileSize: TILE_DEFAULT,
      showHidden: false,
      confirmBeforeDelete: true,
      language: 'system',
      theme: 'system'
    })

    // reset()은 persist 설정(name·version·migrate)을 건드리지 않는다(함정 E).
    expect(useSettingsStore.persist.getOptions().name).toBe('ftp-browser-settings')
    expect(useSettingsStore.persist.getOptions().version).toBe(2)
  })
})
