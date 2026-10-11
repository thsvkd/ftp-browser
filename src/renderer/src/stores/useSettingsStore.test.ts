import { describe, expect, it } from 'vitest'
import { migrateSettings } from './useSettingsStore'

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
})
