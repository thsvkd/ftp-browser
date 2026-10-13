/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { useFileCategoryStore } from '@renderer/stores/useFileCategoryStore'
import { categoryOf, fromFtpEntry, fromLocalEntry } from './explorerEntry'

describe('ExplorerEntry', () => {
  it('maps FTP and local entries to one shape and classifies extensions', () => {
    // covers: Test-773
    const remote = fromFtpEntry(
      {
        name: '.env',
        type: 'file',
        size: 12,
        modifiedAt: '2024-05-01T00:00:00.000Z',
        rawModifiedAt: 'May 1',
        permissions: 'rw-r--r--',
        isImage: false
      },
      '/srv/app',
      'me@host:21'
    )
    expect(remote).toEqual({
      side: 'remote',
      server: 'me@host:21',
      path: '/srv/app/.env',
      name: '.env',
      type: 'file',
      size: 12,
      modifiedAt: '2024-05-01T00:00:00.000Z',
      permissions: 'rw-r--r--',
      hidden: true,
      category: 'other',
      isImage: false
    })
    expect(
      fromFtpEntry(
        {
          name: 'a.jpg',
          type: 'file',
          size: 1,
          modifiedAt: '',
          rawModifiedAt: '',
          isImage: true
        },
        '/',
        's'
      ).path
    ).toBe('/a.jpg')

    const local = fromLocalEntry({
      name: 'photos',
      path: 'C:\\Users\\me\\photos',
      type: 'directory',
      size: 0,
      modifiedAt: '2024-05-01T00:00:00.000Z',
      isImage: false
    })
    expect(local).toEqual({
      side: 'local',
      path: 'C:\\Users\\me\\photos',
      name: 'photos',
      type: 'directory',
      size: 0,
      modifiedAt: '2024-05-01T00:00:00.000Z',
      hidden: false,
      category: 'other',
      isImage: false
    })
    expect(local).not.toHaveProperty('server')

    expect(categoryOf('IMG_0001.JPG')).toBe('image')
    expect(categoryOf('a.cr3')).toBe('raw')
    expect(categoryOf('a.NEF')).toBe('raw')
    expect(categoryOf('clip.mp4')).toBe('video')
    expect(categoryOf('song.mp3')).toBe('audio')
    expect(categoryOf('backup.zip')).toBe('archive')
    expect(categoryOf('main.ts')).toBe('code')
    expect(categoryOf('report.pdf')).toBe('doc')
    expect(categoryOf('README')).toBe('other')
    expect(categoryOf('data.xyz')).toBe('other')
  })

  it('does not depend on the file category settings (icons and thumbnails stay put)', () => {
    // covers: Test-952
    const store = useFileCategoryStore.getState()
    const before = useFileCategoryStore.getState().overrides
    try {
      store.removeExtension('image', 'jpg')
      store.setHidden('image', true)
      expect(categoryOf('a.jpg')).toBe('image')
      const entry = fromFtpEntry(
        {
          name: 'a.jpg',
          type: 'file',
          size: 1,
          modifiedAt: '',
          rawModifiedAt: '',
          isImage: true
        },
        '/',
        's'
      )
      expect(entry.category).toBe('image')
      expect(entry.isImage).toBe(true)
    } finally {
      useFileCategoryStore.setState({ overrides: before })
    }
  })
})
