import { describe, expect, it } from 'vitest'
import { fitCrumbs, pathCrumbs } from './pathCrumbs'

describe('pathCrumbs', () => {
  it('splits remote and local paths and folds the middle to fit', () => {
    // covers: Test-779
    expect(pathCrumbs('remote', '/a/b/c')).toEqual([
      { name: '/', path: '/' },
      { name: 'a', path: '/a' },
      { name: 'b', path: '/a/b' },
      { name: 'c', path: '/a/b/c' }
    ])
    expect(pathCrumbs('remote', '/')).toEqual([{ name: '/', path: '/' }])
    expect(pathCrumbs('local', 'C:\\Users\\me')).toEqual([
      { name: 'C:', path: 'C:\\' },
      { name: 'Users', path: 'C:\\Users' },
      { name: 'me', path: 'C:\\Users\\me' }
    ])
    expect(pathCrumbs('local', '/home/me')).toEqual([
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'me', path: '/home/me' }
    ])

    const crumbs = pathCrumbs('remote', '/a/b/c/d')
    // Root 40, each segment 30, "…" 20.
    const widths = [40, 30, 30, 30, 30]
    // Everything fits.
    expect(fitCrumbs(crumbs, widths, 160, 20)).toEqual({
      root: crumbs[0],
      hidden: [],
      shown: crumbs.slice(1)
    })
    // 40 + … 20 + c 30 + d 30 = 120 fits, b would need 150.
    expect(fitCrumbs(crumbs, widths, 130, 20)).toEqual({
      root: crumbs[0],
      hidden: crumbs.slice(1, 3),
      shown: crumbs.slice(3)
    })
    // Too narrow even for one: the last segment stays (and ellipsizes).
    expect(fitCrumbs(crumbs, widths, 50, 20)).toEqual({
      root: crumbs[0],
      hidden: crumbs.slice(1, 4),
      shown: crumbs.slice(4)
    })
    expect(fitCrumbs([crumbs[0]], [40], 10, 20)).toEqual({ root: crumbs[0], hidden: [], shown: [] })
  })
})
