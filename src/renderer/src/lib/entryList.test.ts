import { describe, expect, it } from 'vitest'
import { filterEntries, sortEntries } from './entryList'
import type { ExplorerEntry } from './explorerEntry'
import { EMPTY_FILTER, EMPTY_OVERRIDES, createMatcher, resolveCategories } from './fileCategories'

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

const photoMatcher = createMatcher(
  { ...EMPTY_FILTER, categories: ['image', 'raw', 'video'] },
  resolveCategories(EMPTY_OVERRIDES)
)

describe('filterEntries', () => {
  it('filters by query (initials too) and file type, and counts what each filter removed', () => {
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

    const all = filterEntries(list, { query: '', matcher: null, showHidden: false })
    expect(all.visible).toHaveLength(6)
    expect(all).toMatchObject({ hiddenCount: 1, queryCount: 0, filterCount: 0 })

    expect(filterEntries(list, { query: '', matcher: null, showHidden: true }).hiddenCount).toBe(0)

    const sky = filterEntries(list, { query: 'sK', matcher: null, showHidden: false })
    expect(names(sky.visible)).toEqual(['Sky.PNG'])
    expect(sky.queryCount).toBe(5)

    // ㄴ arrives as 's' (2-beolsik); typed jamo match the same initials.
    expect(
      names(filterEntries(list, { query: 's', matcher: null, showHidden: false }).visible)
    ).toEqual(['나무.jpg', 'Sky.PNG', 'shot.cr3', 'notes.txt', 'sub'])
    expect(
      names(filterEntries(list, { query: 'ㄴㅁ', matcher: null, showHidden: false }).visible)
    ).toEqual(['나무.jpg'])
    // Substring, not only prefix.
    expect(
      names(filterEntries(list, { query: 'ip', matcher: null, showHidden: false }).visible)
    ).toEqual(['clip.mp4'])

    const photos = filterEntries(list, { query: '', matcher: photoMatcher, showHidden: false })
    expect(names(photos.visible)).toEqual(['나무.jpg', 'Sky.PNG', 'shot.cr3', 'clip.mp4', 'sub'])
    expect(photos).toMatchObject({ hiddenCount: 1, queryCount: 0, filterCount: 1 })
  })

  it('reproduces the old photos-only result with a three-category matcher and counts each entry once', () => {
    // covers: Test-934
    const list = [
      entry('.hidden.jpg', { category: 'image' }),
      entry('나무.jpg', { category: 'image' }),
      entry('Sky.PNG', { category: 'image' }),
      entry('shot.cr3', { category: 'raw' }),
      entry('clip.mp4', { category: 'video' }),
      entry('notes.txt', { category: 'doc' }),
      entry('sub', { type: 'directory' })
    ]
    const photos = filterEntries(list, { query: '', matcher: photoMatcher, showHidden: false })
    expect(names(photos.visible)).toEqual(['나무.jpg', 'Sky.PNG', 'shot.cr3', 'clip.mp4', 'sub'])
    expect(photos).toMatchObject({ hiddenCount: 1, queryCount: 0, filterCount: 1 })

    const none = filterEntries(list, { query: '', matcher: null, showHidden: false })
    expect(none.filterCount).toBe(0)
    expect(none.visible).toHaveLength(6)

    // Search first: only what passed the search can be removed by the filter.
    const withQuery = filterEntries(list, { query: 's', matcher: photoMatcher, showHidden: false })
    expect(names(withQuery.visible)).toEqual(['나무.jpg', 'Sky.PNG', 'shot.cr3', 'sub'])
    expect(withQuery).toMatchObject({ hiddenCount: 1, queryCount: 1, filterCount: 1 })
    expect(
      withQuery.visible.length +
        withQuery.hiddenCount +
        withQuery.queryCount +
        withQuery.filterCount
    ).toBe(list.length)

    // A hidden file is counted as hidden even when the filter would also drop it.
    const hiddenDoc = [entry('.x.txt', { category: 'doc' })]
    expect(
      filterEntries(hiddenDoc, { query: '', matcher: photoMatcher, showHidden: false })
    ).toMatchObject({ hiddenCount: 1, filterCount: 0 })
  })
})
