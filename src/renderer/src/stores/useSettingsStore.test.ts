/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
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
})

describe('useSettingsStore screen toggles', () => {
  it('defaults showSidebar and showRail to true, turns them off and keeps them in the snapshot', () => {
    // covers: Test-883
    expect(useSettingsStore.getInitialState().showSidebar).toBe(true)
    expect(useSettingsStore.getInitialState().showRail).toBe(true)

    useSettingsStore.getState().setShowSidebar(false)
    useSettingsStore.getState().setShowRail(false)
    expect(useSettingsStore.getState().showSidebar).toBe(false)
    expect(useSettingsStore.getState().showRail).toBe(false)

    // persist: 스냅샷에도 남는다(재시작 후 유지의 근거).
    const saved = JSON.parse(localStorage.getItem('ftp-browser-settings') ?? '{}')
    expect(saved.state.showSidebar).toBe(false)
    expect(saved.state.showRail).toBe(false)
  })

  it('reset() returns every setting — tile, default view, hidden, delete confirm, language, theme, screen toggles — to its default', () => {
    // covers: Test-884
    useSettingsStore.setState({
      viewMode: 'list',
      tileSize: 224,
      showHidden: true,
      confirmBeforeDelete: false,
      language: 'ko',
      theme: 'dark',
      showSidebar: false,
      showRail: false
    })

    useSettingsStore.getState().reset()

    expect(useSettingsStore.getState()).toMatchObject({
      viewMode: 'grid',
      tileSize: TILE_DEFAULT,
      showHidden: false,
      confirmBeforeDelete: true,
      language: 'system',
      theme: 'system',
      showSidebar: true,
      showRail: true
    })
  })

  it('fills the two new fields with true when a snapshot from before them is loaded', async () => {
    // covers: Test-885
    localStorage.setItem(
      'ftp-browser-settings',
      JSON.stringify({
        state: {
          viewMode: 'list',
          tileSize: 200,
          showHidden: true,
          confirmBeforeDelete: false,
          language: 'ko',
          theme: 'dark'
        },
        version: 2
      })
    )
    vi.resetModules()
    const { useSettingsStore: fresh } = await import('./useSettingsStore')

    // 저장본 자체는 실제로 불러와졌다(검증 전제).
    expect(fresh.getState().language).toBe('ko')
    expect(fresh.getState().showSidebar).toBe(true)
    expect(fresh.getState().showRail).toBe(true)
  })
})
