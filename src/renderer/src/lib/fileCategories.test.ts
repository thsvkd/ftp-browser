import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CATEGORIES,
  EMPTY_FILTER,
  EMPTY_OVERRIDES,
  activeCount,
  countByCategory,
  createMatcher,
  extensionCounts,
  extensionOf,
  filterLabel,
  normalizeExtension,
  orphanExtensions,
  parseExtensionInput,
  resolveCategories,
  sanitizeOverrides,
  visibleCategories,
  type CategoryOverrides,
  type TabFilter
} from './fileCategories'
import { categoryOf, type ExplorerEntry } from './explorerEntry'

function file(name: string, type: ExplorerEntry['type'] = 'file'): ExplorerEntry {
  return {
    side: 'local',
    path: `/${name}`,
    name,
    type,
    size: 0,
    modifiedAt: '2024-01-01T00:00:00.000Z',
    hidden: false,
    category: 'other',
    isImage: false
  }
}

const filter = (over: Partial<TabFilter>): TabFilter => ({ ...EMPTY_FILTER, ...over })
const resolved = (o: CategoryOverrides = EMPTY_OVERRIDES): ReturnType<typeof resolveCategories> =>
  resolveCategories(o)

describe('normalizeExtension / parseExtensionInput / extensionOf', () => {
  it('normalizes an extension: trim, lower-case, drop leading dots, reject bad tokens', () => {
    // covers: Test-920
    expect(normalizeExtension(' .JPG ')).toBe('jpg')
    expect(normalizeExtension('..png')).toBe('png')
    expect(normalizeExtension('Tar.GZ')).toBe('tar.gz')
    for (const bad of ['', '.', 'a b', 'a/b', 'a\\b', 'tar.', 'a..b'])
      expect(normalizeExtension(bad)).toBeNull()
  })

  it('splits tag input on comma, semicolon and whitespace', () => {
    // covers: Test-921
    expect(parseExtensionInput('jpg, .PNG;webp  jpg a/b')).toEqual({
      valid: ['jpg', 'png', 'webp'],
      invalid: ['a/b']
    })
    expect(parseExtensionInput('')).toEqual({ valid: [], invalid: [] })
    expect(parseExtensionInput('   ')).toEqual({ valid: [], invalid: [] })
  })

  it('extracts the extension after the last dot, but not for a leading or trailing dot', () => {
    // covers: Test-922
    expect(extensionOf('IMG.JPG')).toBe('jpg')
    expect(extensionOf('a.tar.gz')).toBe('gz')
    expect(extensionOf('README')).toBe('')
    expect(extensionOf('.gitignore')).toBe('')
    expect(extensionOf('.config.json')).toBe('json')
    expect(extensionOf('a.')).toBe('')
    expect(extensionOf('한글.JPG')).toBe('jpg')
    expect(extensionOf('a.b.C')).toBe('c')
  })
})

describe('DEFAULT_CATEGORIES', () => {
  it('matches the agreed table and the legacy icon classification', () => {
    // covers: Test-923
    expect(DEFAULT_CATEGORIES.map((c) => c.id)).toEqual([
      'image',
      'raw',
      'video',
      'audio',
      'doc',
      'archive',
      'code'
    ])
    const seen = new Map<string, string>()
    for (const c of DEFAULT_CATEGORIES) {
      expect(new Set(c.extensions).size).toBe(c.extensions.length)
      for (const ext of c.extensions) {
        expect(normalizeExtension(ext)).toBe(ext)
        expect(seen.get(ext)).toBeUndefined()
        seen.set(ext, c.id)
        const legacy = categoryOf(`x.${ext}`)
        if (legacy !== 'other') expect(legacy).toBe(c.id)
      }
    }
    expect(seen.get('ts')).toBe('code')
    const of = (id: string): readonly string[] =>
      DEFAULT_CATEGORIES.find((c) => c.id === id)?.extensions ?? []
    for (const ext of ['crw', 'nrw', 'srf', 'sr2', 'x3f']) expect(of('raw')).toContain(ext)
    expect(of('doc')).toContain('log')
    expect(of('archive')).toContain('dmg')
    for (const ext of ['mjs', 'cjs', 'scss']) expect(of('code')).toContain(ext)
    const table: Record<string, string> = {
      image: 'jpg jpeg png gif webp bmp tif tiff svg heic heif avif ico psd',
      raw: 'cr2 cr3 nef arw dng orf rw2 raf srw pef crw nrw srf sr2 x3f',
      video: 'mp4 mkv mov avi wmv flv webm m4v mpg mpeg m2ts mts 3gp',
      audio: 'mp3 flac wav aac m4a ogg opus wma aiff',
      doc: 'pdf doc docx xls xlsx ppt pptx odt ods odp txt md rtf csv epub hwp hwpx log',
      archive: 'zip rar 7z tar gz tgz bz2 xz zst iso dmg',
      code: 'js ts jsx tsx py java c cpp h cs go rs rb php sh ps1 json yaml yml toml xml html css sql mjs cjs scss'
    }
    for (const c of DEFAULT_CATEGORIES) expect([...c.extensions]).toEqual(table[c.id].split(' '))
  })
})

describe('resolveCategories', () => {
  it('resolves the defaults in order when nothing is edited', () => {
    // covers: Test-924
    const all = resolved()
    expect(all.map((c) => c.id)).toEqual(DEFAULT_CATEGORIES.map((c) => c.id))
    for (const [i, c] of all.entries()) {
      expect(c).toMatchObject({ kind: 'default', hidden: false, nameKey: `category.${c.id}` })
      expect(c.extensions).toEqual([...DEFAULT_CATEGORIES[i].extensions])
    }
    expect(visibleCategories(all)).toHaveLength(all.length)
  })

  it('applies removed/added/hidden, appends custom categories and merges newer defaults', () => {
    // covers: Test-925
    const o: CategoryOverrides = {
      defaults: {
        image: { added: ['heics', 'jpg'], removed: ['png'], hidden: false },
        code: { added: [], removed: [], hidden: true }
      },
      custom: [
        { id: 'custom-a', name: 'Docs', extensions: ['txt'] },
        { id: 'custom-b', name: 'More', extensions: [] }
      ]
    }
    const all = resolved(o)
    const image = all.find((c) => c.id === 'image')!
    expect(image.extensions).not.toContain('png')
    expect(image.extensions.at(-1)).toBe('heics')
    expect(image.extensions.filter((e) => e === 'jpg')).toHaveLength(1)
    expect(visibleCategories(all).map((c) => c.id)).toEqual([
      'image',
      'raw',
      'video',
      'audio',
      'doc',
      'archive',
      'custom-a',
      'custom-b'
    ])
    expect(all.slice(-2)).toMatchObject([
      { id: 'custom-a', kind: 'custom', name: 'Docs', hidden: false, extensions: ['txt'] },
      { id: 'custom-b', kind: 'custom', name: 'More' }
    ])

    const newer = DEFAULT_CATEGORIES.map((c) =>
      c.id === 'image'
        ? { id: c.id, extensions: [...c.extensions.filter((e) => e !== 'bmp'), 'jxl'] }
        : c
    )
    const merged = resolveCategories(o, newer).find((c) => c.id === 'image')!
    expect(merged.extensions).toContain('jxl')
    expect(merged.extensions).not.toContain('bmp')
    expect(merged.extensions).not.toContain('png')
    expect(merged.extensions).toContain('heics')
  })
})

describe('sanitizeOverrides', () => {
  it('survives garbage and keeps good values', () => {
    // covers: Test-926
    for (const bad of [null, undefined, [], 'x', 3, { defaults: [], custom: 'x' }])
      expect(sanitizeOverrides(bad)).toEqual(EMPTY_OVERRIDES)
    const out = sanitizeOverrides({
      photosOnly: true,
      defaults: {
        image: { added: ['HEICS', 3, 'a/b', 'heics'], removed: ['png'], hidden: true },
        nope: { added: ['x'], removed: [], hidden: false },
        raw: 'oops'
      },
      custom: [
        { id: 'custom-a', name: ' Docs ', extensions: ['txt', 5, 'bad ext'] },
        { id: 'custom-a', name: 'Dup', extensions: [] },
        { id: 'custom-b', name: '   ', extensions: [] },
        { id: 7, name: 'x', extensions: [] },
        { id: 'custom-c', name: 'Ok', extensions: 'nope' }
      ]
    })
    expect(out.defaults.image).toEqual({ added: ['heics'], removed: ['png'], hidden: true })
    expect(Object.keys(out.defaults)).toEqual(['image'])
    expect(out.custom).toEqual([
      { id: 'custom-a', name: 'Docs', extensions: ['txt'] },
      { id: 'custom-c', name: 'Ok', extensions: [] }
    ])
    const good: CategoryOverrides = {
      defaults: { raw: { added: ['xyz'], removed: [], hidden: false } },
      custom: [{ id: 'custom-1', name: 'Mine', extensions: ['a', 'b.c'] }]
    }
    expect(sanitizeOverrides(good)).toEqual(good)
  })
})

describe('createMatcher / activeCount', () => {
  it('unions categories, extensions and "no extension"; ignores hidden or unknown categories', () => {
    // covers: Test-927
    const all = resolved({
      defaults: { video: { added: [], removed: [], hidden: true } },
      custom: []
    })
    expect(createMatcher(EMPTY_FILTER, all)).toBeNull()
    expect(createMatcher(filter({ categories: ['video'] }), all)).toBeNull()
    expect(createMatcher(filter({ categories: ['gone'] }), all)).toBeNull()

    const cats = createMatcher(filter({ categories: ['image'] }), all)!
    expect(cats(file('a.jpg'))).toBe(true)
    expect(cats(file('a.txt'))).toBe(false)
    const exts = createMatcher(filter({ extensions: ['txt'] }), all)!
    expect(exts(file('a.TXT'))).toBe(true)
    expect(exts(file('a.jpg'))).toBe(false)
    const none = createMatcher(filter({ noExtension: true }), all)!
    expect(none(file('README'))).toBe(true)
    expect(none(file('a.jpg'))).toBe(false)
    const mixed = createMatcher(
      filter({ categories: ['image', 'video', 'gone'], extensions: ['txt'], noExtension: true }),
      all
    )!
    expect([
      mixed(file('a.jpg')),
      mixed(file('a.txt')),
      mixed(file('README')),
      mixed(file('a.mp4')),
      mixed(file('a.zip'))
    ]).toEqual([true, true, true, false, false])

    expect(activeCount(EMPTY_FILTER, all)).toBe(0)
    expect(activeCount(filter({ categories: ['video'] }), all)).toBe(0)
    expect(
      activeCount(
        filter({
          categories: ['image', 'video', 'gone'],
          extensions: ['a', 'b'],
          noExtension: true
        }),
        all
      )
    ).toBe(4)
  })
})

describe('matching rules', () => {
  it('matches case-insensitively, by compound suffix, and always lets folders through', () => {
    // covers: Test-928
    const all = resolved()
    const jpg = createMatcher(filter({ extensions: ['jpg'] }), all)!
    expect(jpg(file('IMG.JPG'))).toBe(true)

    const both = createMatcher(filter({ extensions: ['gz', 'tar.gz'] }), all)!
    const gz = createMatcher(filter({ extensions: ['gz'] }), all)!
    const targz = createMatcher(filter({ extensions: ['tar.gz'] }), all)!
    const tar = createMatcher(filter({ extensions: ['tar'] }), all)!
    expect(both(file('a.tar.gz'))).toBe(true)
    expect(gz(file('a.tar.gz'))).toBe(true)
    expect(targz(file('a.tar.gz'))).toBe(true)
    expect(targz(file('A.TAR.GZ'))).toBe(true)
    expect(tar(file('a.tar.gz'))).toBe(false)
    expect(targz(file('b.gz'))).toBe(false)
    expect(targz(file('tar.gz'))).toBe(false)
    expect(targz(file('.tar.gz'))).toBe(false)

    const none = createMatcher(filter({ noExtension: true }), all)!
    for (const n of ['README', '.gitignore', 'a.']) expect(none(file(n))).toBe(true)
    expect(none(file('a.txt'))).toBe(false)

    const other = createMatcher(filter({ extensions: ['zzz'] }), all)!
    expect(other(file('x.png', 'directory'))).toBe(true)
    expect(other(file('x', 'directory'))).toBe(true)

    // Symlinks are judged by name (E18).
    expect(jpg(file('link.jpg', 'symbolic-link'))).toBe(true)
    expect(jpg(file('link.txt', 'symbolic-link'))).toBe(false)
  })
})

describe('countByCategory / extensionCounts / orphanExtensions', () => {
  it('counts files only, keeps zero keys and counts a file in every category that has it', () => {
    // covers: Test-929
    const all = resolved({
      defaults: {},
      custom: [{ id: 'custom-1', name: 'Pics', extensions: ['jpg'] }]
    })
    const files = [
      file('a.jpg'),
      file('b.JPG'),
      file('c.cr3'),
      file('d.png', 'directory'),
      file('e.tar.gz'),
      file('f.gz'),
      file('README'),
      file('.gitignore'),
      file('g.txt'),
      file('link.jpg', 'symbolic-link')
    ]
    const counts = countByCategory(files, visibleCategories(all))
    expect(Object.keys(counts)).toEqual([...visibleCategories(all).map((c) => c.id)])
    expect(counts).toMatchObject({
      image: 3,
      raw: 1,
      video: 0,
      audio: 0,
      doc: 1,
      archive: 2,
      code: 0,
      'custom-1': 3
    })

    const ext = extensionCounts(files)
    expect(ext.noExtension).toBe(2)
    expect(ext.exts).toEqual([
      { ext: 'jpg', count: 3 },
      { ext: 'gz', count: 2 },
      { ext: 'cr3', count: 1 },
      { ext: 'txt', count: 1 }
    ])
    expect(extensionCounts([file('d.dir', 'directory')])).toEqual({ exts: [], noExtension: 0 })

    const input = ['jpg', 'tar.gz', 'log']
    expect(orphanExtensions(input, ['log', 'txt'])).toEqual(['jpg', 'tar.gz'])
    expect(orphanExtensions([], ['log'])).toEqual([])
    expect(input).toEqual(['jpg', 'tar.gz', 'log'])
  })
})

describe('filterLabel', () => {
  it('lists categories, then extensions, then "no extension", and trims after max', () => {
    // covers: Test-930
    const all = resolved({
      defaults: { video: { added: [], removed: [], hidden: true } },
      custom: []
    })
    const nameOf = (c: { id: string }): string => c.id.toUpperCase()
    expect(filterLabel(filter({ categories: ['image'] }), all, nameOf, 'NOEXT')).toBe('IMAGE')
    expect(
      filterLabel(
        filter({ categories: ['image', 'raw'], extensions: ['log'], noExtension: true }),
        all,
        nameOf,
        'NOEXT'
      )
    ).toBe('IMAGE, RAW, .log +1')
    expect(
      filterLabel(
        filter({ categories: ['image'], extensions: ['log'], noExtension: true }),
        all,
        nameOf,
        'NOEXT'
      )
    ).toBe('IMAGE, .log, NOEXT')
    expect(
      filterLabel(filter({ categories: ['image', 'raw', 'doc', 'code'] }), all, nameOf, 'NOEXT', 2)
    ).toBe('IMAGE, RAW +2')
    // Hidden and unknown ids are not part of the label.
    expect(
      filterLabel(filter({ categories: ['video', 'gone', 'raw'] }), all, nameOf, 'NOEXT')
    ).toBe('RAW')
  })
})
