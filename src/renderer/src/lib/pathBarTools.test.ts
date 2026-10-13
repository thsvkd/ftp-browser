import { describe, expect, it } from 'vitest'
import {
  PATH_TOOL_KEEP,
  PATH_TOOL_ORDER,
  fitPathTools,
  type PathBarMeasure,
  type PathToolId
} from './pathBarTools'

// Tailwind 클래스에서 센 폭(간격 제외). 간격을 넣으면 고정 80, ⋯ 38, 도구 합 357이다.
const TOOLS: Record<PathToolId, number> = {
  forward: 32,
  reload: 28,
  search: 36,
  filter: 38,
  sort: 49,
  view: 68,
  newFolder: 32,
  info: 32
}
const measure = (bar: number, tools: Partial<Record<PathToolId, number>> = {}): PathBarMeasure => ({
  bar,
  back: 32,
  up: 32,
  more: 32,
  tools: { ...TOOLS, ...tools }
})

describe('fitPathTools', () => {
  it('shows every tool when the bar fits them or has no layout, and folds from the least kept at the edge', () => {
    // covers: Test-1161
    expect(fitPathTools(measure(0), false)).toMatchObject({
      shown: [...PATH_TOOL_ORDER],
      overflow: [],
      searchInSlot: false
    })
    expect(fitPathTools(measure(621), false)).toEqual({
      shown: [...PATH_TOOL_ORDER],
      overflow: [],
      searchInSlot: false,
      crumbWidth: 160
    })
    expect(fitPathTools(measure(620), false)).toEqual({
      shown: ['forward', 'reload', 'search', 'filter', 'sort', 'view'],
      overflow: ['newFolder', 'info'],
      searchInSlot: false,
      crumbWidth: 197
    })
  })

  it('keeps a strict prefix of the keep order even when a smaller later tool would fit', () => {
    // covers: Test-1162
    expect(PATH_TOOL_KEEP).toEqual([
      'search',
      'filter',
      'sort',
      'view',
      'forward',
      'reload',
      'newFolder',
      'info'
    ])
    expect(PATH_TOOL_ORDER).toEqual([
      'forward',
      'reload',
      'search',
      'filter',
      'sort',
      'view',
      'newFolder',
      'info'
    ])
    const fit = fitPathTools(measure(516, { sort: 300 }), false)
    expect(fit.shown).toEqual(['search', 'filter'])
    expect(fit.overflow).toEqual(['forward', 'reload', 'sort', 'view', 'newFolder', 'info'])
  })

  it('reserves the crumb slot before tools at each pane width', () => {
    // covers: Test-1163
    const cases: Array<[number, PathToolId[], number]> = [
      [240, [], 98],
      [258, [], 116],
      [280, [], 138],
      [346, ['search'], 162],
      [400, ['search', 'filter'], 172],
      [516, ['search', 'filter', 'sort'], 233],
      [238, [], 96],
      // 바닥 아래에서도 음수 예산으로 도구를 넣지 않는다.
      [230, [], 88]
    ]
    for (const [bar, shown, crumbWidth] of cases) {
      const fit = fitPathTools(measure(bar), false)
      expect({ bar, shown: fit.shown, crumbWidth: fit.crumbWidth }).toEqual({
        bar,
        shown,
        crumbWidth
      })
    }
    for (const bar of [240, 258, 280])
      expect(fitPathTools(measure(bar), false).overflow).toEqual([...PATH_TOOL_ORDER])
  })

  it('lets an open find field that does not fit take the crumb slot', () => {
    // covers: Test-1164
    const open = (bar: number): ReturnType<typeof fitPathTools> =>
      fitPathTools(measure(bar, { search: 150 }), true)
    expect(open(516)).toMatchObject({ shown: ['search', 'filter'], searchInSlot: false })
    expect(open(400)).toEqual({
      shown: ['filter'],
      overflow: ['forward', 'reload', 'sort', 'view', 'newFolder', 'info'],
      searchInSlot: true,
      crumbWidth: 214
    })
    expect(open(735)).toMatchObject({
      shown: [...PATH_TOOL_ORDER],
      overflow: [],
      searchInSlot: false
    })
    expect(fitPathTools(measure(400), false)).toMatchObject({
      shown: ['search', 'filter'],
      searchInSlot: false
    })
  })
})
