import { describe, expect, it } from 'vitest'
import { filterEntries, sortEntries } from './entryList'
import type { ExplorerEntry } from './explorerEntry'

function entry(name: string, over: Partial<ExplorerEntry> = {}): ExplorerEntry {
  return {
    side: 'remote',
    server: 's',
    path: `/${name}`,
    name,
    type: 'file',
    size: 0,
    modifiedAt: '2024-01-01T00:00:00.000Z',
    hidden: name.startsWith('.'),
    category: 'other',
    isImage: false,
    ...over
  }
}

const names = (list: ExplorerEntry[]): string[] => list.map((e) => e.name)

describe('sortEntries', () => {
  it('sorts naturally, folders first, by size/date/type, both directions, ties by name', () => {
    // covers: Test-771
    const list = [
      entry('IMG_10.jpg', { size: 5, modifiedAt: '2024-03-01T00:00:00.000Z' }),
      entry('b-dir', { type: 'directory' }),
      entry('IMG_2.jpg', { size: 5, modifiedAt: '2024-01-01T00:00:00.000Z' }),
      entry('a.txt', { size: 9, modifiedAt: '2024-02-01T00:00:00.000Z' }),
      entry('A-dir', { type: 'directory' })
    ]

    const byName = { key: 'name', dir: 'asc', foldersFirst: true } as const
    expect(names(sortEntries(list, byName))).toEqual([
      'A-dir',
      'b-dir',
      'a.txt',
      'IMG_2.jpg',
      'IMG_10.jpg'
    ])
    expect(names(sortEntries(list, { ...byName, dir: 'desc' }))).toEqual([
      'b-dir',
      'A-dir',
      'IMG_10.jpg',
      'IMG_2.jpg',
      'a.txt'
    ])
    expect(names(sortEntries(list, { ...byName, foldersFirst: false }))).toEqual([
      'A-dir',
      'a.txt',
      'b-dir',
      'IMG_2.jpg',
      'IMG_10.jpg'
    ])

    // Same size → name order.
    expect(names(sortEntries(list, { key: 'size', dir: 'asc', foldersFirst: true }))).toEqual([
      'A-dir',
      'b-dir',
      'IMG_2.jpg',
      'IMG_10.jpg',
      'a.txt'
    ])
    expect(
      names(sortEntries(list, { key: 'size', dir: 'desc', foldersFirst: true })).slice(2)
    ).toEqual(['a.txt', 'IMG_2.jpg', 'IMG_10.jpg'])
    expect(
      names(sortEntries(list, { key: 'modified', dir: 'asc', foldersFirst: true })).slice(2)
    ).toEqual(['IMG_2.jpg', 'a.txt', 'IMG_10.jpg'])
    expect(
      names(sortEntries(list, { key: 'modified', dir: 'desc', foldersFirst: true })).slice(2)
    ).toEqual(['IMG_10.jpg', 'a.txt', 'IMG_2.jpg'])
    expect(
      names(sortEntries(list, { key: 'type', dir: 'asc', foldersFirst: true })).slice(2)
    ).toEqual(['IMG_2.jpg', 'IMG_10.jpg', 'a.txt'])
    // Input is not mutated.
    expect(names(list)[0]).toBe('IMG_10.jpg')
  })
})

describe('filterEntries', () => {
  it('filters by query (initials too) and photos, and counts what each filter removed', () => {
    // covers: Test-772
    const list = [
      entry('.hidden.jpg', { category: 'image' }),
      entry('나무.jpg', { category: 'image' }),
      entry('Sky.PNG', { category: 'image' }),
      entry('shot.cr3', { category: 'raw' }),
      entry('clip.mp4', { category: 'video' }),
      entry('notes.txt', { category: 'doc' }),
      entry('sub', { type: 'directory' })
    ]

    const all = filterEntries(list, { query: '', photosOnly: false, showHidden: false })
    expect(all.visible).toHaveLength(6)
    expect(all).toMatchObject({ hiddenCount: 1, queryCount: 0, photosCount: 0 })

    expect(
      filterEntries(list, { query: '', photosOnly: false, showHidden: true }).hiddenCount
    ).toBe(0)

    const sky = filterEntries(list, { query: 'sK', photosOnly: false, showHidden: false })
    expect(names(sky.visible)).toEqual(['Sky.PNG'])
    expect(sky.queryCount).toBe(5)

    // ㄴ arrives as 's' (2-beolsik); typed jamo match the same initials.
    expect(
      names(filterEntries(list, { query: 's', photosOnly: false, showHidden: false }).visible)
    ).toEqual(['나무.jpg', 'Sky.PNG', 'shot.cr3', 'notes.txt', 'sub'])
    expect(
      names(filterEntries(list, { query: 'ㄴㅁ', photosOnly: false, showHidden: false }).visible)
    ).toEqual(['나무.jpg'])
    // Substring, not only prefix.
    expect(
      names(filterEntries(list, { query: 'ip', photosOnly: false, showHidden: false }).visible)
    ).toEqual(['clip.mp4'])

    const photos = filterEntries(list, { query: '', photosOnly: true, showHidden: false })
    expect(names(photos.visible)).toEqual(['나무.jpg', 'Sky.PNG', 'shot.cr3', 'clip.mp4', 'sub'])
    expect(photos).toMatchObject({ hiddenCount: 1, queryCount: 0, photosCount: 1 })
  })
})
