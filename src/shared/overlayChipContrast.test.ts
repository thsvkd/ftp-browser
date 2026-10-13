import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// 분할 오버레이 칩의 글자 대비(explorer-ux-polish X11). 칩은 불투명 `--sf` 위에 "남는 탭"은 `--mu`,
// 칠한 칩은 `--tx`로 쓴다. 토큰을 바꾸면 두 테마에서 WCAG AA(4.5:1)를 지켜야 한다.
const css = fs.readFileSync(path.join(process.cwd(), 'src/renderer/src/styles/globals.css'), 'utf8')

/** `selector {`로 시작하는 블록 본문(중괄호 짝을 맞춘다). */
function block(source: string, start: number): string {
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i)
  }
  throw new Error('unclosed block')
}

function tokens(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}

function themes(): { light: Record<string, string>; dark: Record<string, string> } {
  const lightAt = css.search(/^:root\s*\{/m)
  const mediaAt = css.search(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/)
  if (lightAt < 0 || mediaAt < 0) throw new Error('theme blocks not found')
  const media = block(css, mediaAt)
  const darkAt = media.search(/:root\s*\{/)
  if (darkAt < 0) throw new Error('dark :root block not found')
  return { light: tokens(block(css, lightAt)), dark: tokens(block(media, darkAt)) }
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`)
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('split overlay chip contrast', () => {
  it('keeps --mu and --tx on --sf at WCAG AA in both themes', () => {
    // covers: Test-1173
    const { light, dark } = themes()
    for (const [name, theme] of [
      ['light', light],
      ['dark', dark]
    ] as const) {
      for (const token of ['--mu', '--sf', '--tx'])
        expect(theme[token], `${name} ${token}`).toMatch(/^#[0-9a-f]{6}$/i)
      expect(contrast(theme['--mu'], theme['--sf']), `${name} --mu/--sf`).toBeGreaterThanOrEqual(
        4.5
      )
      expect(contrast(theme['--tx'], theme['--sf']), `${name} --tx/--sf`).toBeGreaterThanOrEqual(
        4.5
      )
    }
  })
})
