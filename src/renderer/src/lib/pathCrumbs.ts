/** 경로 막대의 조각: 루트부터 나누고, 폭이 모자라면 가운데를 "…"로 접는다. */
import { joinPath, type Side } from './explorerEntry'

export interface Crumb {
  name: string
  path: string
}

/** 루트가 첫 조각이다: 원격 `/`, Windows `C:`(경로 `C:\`), 그 밖 로컬 `/`. */
export function pathCrumbs(side: Side, path: string): Crumb[] {
  const drive = side === 'local' ? /^([A-Za-z]:)[\\/]?/.exec(path) : null
  const root: Crumb = drive ? { name: drive[1], path: `${drive[1]}\\` } : { name: '/', path: '/' }
  const out = [root]
  let cur = root.path
  for (const part of path.slice(drive ? drive[0].length : 0).split(/[\\/]/)) {
    if (!part) continue
    cur = joinPath(side, cur, part)
    out.push({ name: part, path: cur })
  }
  return out
}

/**
 * 폭 `available`에 맞게 접는다. `widths[i]`는 `crumbs[i]`의 폭, `moreWidth`는 "…" 버튼 폭.
 * 루트와 마지막 조각은 늘 남고(마지막만 말줄임될 수 있다), 그 앞으로 들어가는 만큼 뒤쪽 조각을 남긴다.
 */
export function fitCrumbs(
  crumbs: readonly Crumb[],
  widths: readonly number[],
  available: number,
  moreWidth: number
): { root: Crumb; hidden: Crumb[]; shown: Crumb[] } {
  const below = crumbs.slice(1)
  let keep = below.length
  const fits = (n: number): boolean =>
    widths[0] +
      (n < below.length ? moreWidth : 0) +
      widths.slice(widths.length - n).reduce((a, b) => a + b, 0) <=
    available
  while (keep > 1 && !fits(keep)) keep--
  return {
    root: crumbs[0],
    hidden: below.slice(0, below.length - keep),
    shown: below.slice(below.length - keep)
  }
}
