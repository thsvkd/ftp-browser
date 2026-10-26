import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// 선택 = 포커스 모델(docs/handoff/explorer-menu-and-focus.md F8·F10)의 저장소 계약.
// CSS와 쓰기 경로는 컴포넌트 테스트가 보지 못하므로 파일을 읽어 고정한다.

const repoRoot = process.cwd()
const RENDERER = 'src/renderer/src'

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

/** `src/renderer/src` 아래 테스트가 아닌 .ts/.tsx/.css 파일(저장소 기준 경로). */
function rendererSources(dir = RENDERER): string[] {
  return fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = `${dir}/${d.name}`
    if (d.isDirectory()) return rendererSources(rel)
    return /\.(tsx?|css)$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [rel] : []
  })
}

describe('focus model contract', () => {
  it('drops the inactive selection colour, the cursor ring and direct selection writes', () => {
    // covers: Test-864
    // ① globals.css에서 --selin과 .ring-focus가 사라졌다.
    const css = readRepoFile(`${RENDERER}/styles/globals.css`)
    expect(css).not.toContain('--selin')
    expect(css).not.toContain('.ring-focus')

    // ② 테스트가 아닌 renderer 소스 어디에도 옛 커서·회색·축소 흔적이 없다.
    const leftovers = rendererSources().flatMap((file) => {
      const text = readRepoFile(file)
      return ['--selin', 'ring-focus', 'listFocused', 'scale-[0.94]']
        .filter((token) => text.includes(token))
        .map((token) => `${file}: ${token}`)
    })
    expect(leftovers).toEqual([])

    // ③ items[0] 대체가 없고, sel/anchor/focus를 patch로 직접 쓰는 곳은 selectOnly 도우미 하나뿐이다.
    const explorer = readRepoFile(`${RENDERER}/components/explorer/Explorer.tsx`)
    expect(explorer).not.toContain('items[0]?.path')
    const writes = explorer.match(/patch\(\{[^}]*\b(?:sel|anchor|focus)\b/g) ?? []
    expect(writes).toHaveLength(1)
    expect(explorer).toContain(
      'const selectOnly = (path: string): void => patch({ sel: [path], anchor: path, focus: path })'
    )

    // ④ 고대비에서는 [aria-selected='true'] 윤곽선이 선택의 유일한 표시라 남는다.
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'))
    expect(css).toContain('@media (forced-colors: active)')
    expect(forced).toMatch(/\[aria-selected='true'\],?[^{]*\{\s*outline: 2px solid Highlight;/)
  })

  it('outlines the selected sidebar server row in forced colors too', () => {
    // covers: Test-1307
    // 사이드바 서버 행은 선택을 aria-pressed로 보인다(F19). 고대비에서는 배경이 지워지므로 윤곽선이 필요하다.
    const css = readRepoFile('src/renderer/src/styles/globals.css')
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'))
    expect(forced).toMatch(
      /\[data-region='sidebar'\] \[aria-pressed='true'\]\s*\{\s*outline: 2px solid Highlight;/
    )
  })
})
