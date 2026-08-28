import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// npm test / setup scripts run from the repo root.
const repoRoot = process.cwd()

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripYamlQuotes(value: string): string {
  if (value.length >= 2) {
    const start = value[0]
    const end = value[value.length - 1]
    if ((start === "'" && end === "'") || (start === '"' && end === '"')) {
      return value.slice(1, -1)
    }
  }
  return value
}

function parseInlineYamlList(inline: string): string[] {
  if (inline.startsWith('[') && inline.endsWith(']')) {
    return inline
      .slice(1, -1)
      .split(',')
      .map((part) => stripYamlQuotes(part.trim()))
      .filter((part) => part.length > 0)
  }
  return [stripYamlQuotes(inline)]
}

/** First mapping named `key`, including indented children. Skips comment lines. */
function yamlBlock(source: string, key: string): string {
  const lines = source.split(/\r?\n/)
  const keyRe = new RegExp(`^([ \\t]*)${escapeRegExp(key)}:\\s*(.*)$`)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('#')) continue
    const match = lines[i].match(keyRe)
    if (!match) continue
    const indent = match[1]
    const collected: string[] = []
    const inline = match[2].trim()
    if (inline) collected.push(inline)
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (line.trim() === '') {
        collected.push(line)
        continue
      }
      if (line.trimStart().startsWith('#')) continue
      const lineIndent = line.match(/^[ \t]*/)?.[0] ?? ''
      if (lineIndent.length <= indent.length) break
      collected.push(line)
    }
    return collected.join('\n')
  }
  return ''
}

function mappingKeys(block: string): string[] {
  const lines = block.split(/\r?\n/)
  let minIndent: string | null = null
  const keys: string[] = []
  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.match(/^[ \t]*/)?.[0] ?? ''
    if (minIndent === null) minIndent = indent
    if (indent !== minIndent) continue
    const keyMatch = line.match(/^[ \t]*([^:#\s][^:]*):/)
    if (keyMatch) keys.push(keyMatch[1].trim())
  }
  return keys
}

/** Every list/scalar under `key`. Nested lists under a different key are ignored. */
function yamlListItems(block: string, key: string): string[] {
  const lines = block.split(/\r?\n/)
  const keyRe = new RegExp(`^([ \\t]*)${escapeRegExp(key)}:\\s*(.*)$`)
  const found: string[] = []

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('#')) continue
    const match = lines[i].match(keyRe)
    if (!match) continue
    const indent = match[1]
    const inline = match[2].trim()
    if (inline) {
      found.push(...parseInlineYamlList(inline))
      continue
    }
    let itemIndent: string | null = null
    for (let j = i + 1; j < lines.length; j++) {
      const child = lines[j]
      if (child.trim() === '' || child.trimStart().startsWith('#')) continue
      const childIndent = child.match(/^[ \t]*/)?.[0] ?? ''
      if (childIndent.length <= indent.length) break
      const dash = child.match(/^([ \t]*)-\s+(.*)$/)
      if (!dash) continue
      if (itemIndent === null) itemIndent = dash[1]
      if (dash[1] === itemIndent) {
        found.push(stripYamlQuotes(dash[2].trim()))
      }
    }
  }
  return found
}

function yamlScalar(block: string, key: string): string | undefined {
  const keyRe = new RegExp(`^([ \\t]*)${escapeRegExp(key)}:\\s*(.*)$`)
  for (const line of block.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue
    const match = line.match(keyRe)
    if (!match) continue
    let inline = match[2].trim()
    const hash = inline.indexOf(' #')
    if (hash !== -1) inline = inline.slice(0, hash).trim()
    if (!inline) return undefined
    return stripYamlQuotes(inline)
  }
  return undefined
}

function winTargetNames(winBlock: string): string[] {
  return yamlListItems(winBlock, 'target').map((item) => {
    if (item.startsWith('target:')) {
      return stripYamlQuotes(item.slice('target:'.length).trim())
    }
    return item
  })
}

function uncommented(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
}

/** Drop an unquoted `#...` comment. `#` inside quotes is left alone. */
function stripInlineComment(line: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd()
    }
  }
  return line
}

function walkLines(source: string): { line: string; index: number }[] {
  const result: { line: string; index: number }[] = []
  const re = /\r\n|\n|\r/g
  let last = 0
  let match
  while ((match = re.exec(source)) !== null) {
    result.push({ line: source.slice(last, match.index), index: last })
    last = match.index + match[0].length
  }
  result.push({ line: source.slice(last), index: last })
  return result
}

function isWriteOrEcho(line: string): boolean {
  const cmd = line.trim().replace(/^(?:&|\.|call)\s+/i, '')
  return /^(?:Write-Host|Write-Output|echo)\b/i.test(cmd)
}

function isBlockScalarIndicator(value: string): boolean {
  return /^(?:[|>][+-]?)$/.test(value)
}

/** Command text of each `run:` / `pwsh:` / `powershell:` line (not step names). */
function extractWorkflowRunLines(source: string): { index: number; text: string }[] {
  const lines = walkLines(source)
  const found: { index: number; text: string }[] = []

  for (let i = 0; i < lines.length; i++) {
    const stripped = stripInlineComment(lines[i].line)
    if (stripped.trim() === '' || stripped.trimStart().startsWith('#')) continue

    const runMatch = stripped.match(/^([ \t]*)(?:run|pwsh|powershell):\s*(.*)$/)
    if (!runMatch) continue

    const indent = runMatch[1]
    const rest = runMatch[2].trim()
    if (isBlockScalarIndicator(rest)) {
      for (let j = i + 1; j < lines.length; j++) {
        const childRaw = lines[j].line
        const child = stripInlineComment(childRaw)
        if (child.trim() === '') continue
        if (child.trimStart().startsWith('#')) continue
        const childIndent = childRaw.match(/^[ \t]*/)?.[0] ?? ''
        if (childIndent.length <= indent.length) break
        const text = child.trim()
        if (!text) continue
        const lead = childRaw.length - childRaw.trimStart().length
        found.push({ index: lines[j].index + lead, text })
      }
      continue
    }

    if (rest) {
      const unquoted = stripYamlQuotes(rest)
      found.push({
        index: lines[i].index + stripped.indexOf(runMatch[2]),
        text: unquoted
      })
    }
  }
  return found
}

function indexOutsideQuotes(line: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const global = new RegExp(pattern.source, flags)
  let match
  while ((match = global.exec(line)) !== null) {
    const before = line.slice(0, match.index)
    const singles = (before.match(/'/g) ?? []).length
    const doubles = (before.match(/"/g) ?? []).length
    if (singles % 2 === 0 && doubles % 2 === 0) return match.index
  }
  return -1
}

function testCommandOffset(line: string): number {
  const text = stripInlineComment(line)
  if (isWriteOrEcho(text)) return -1
  const npm = indexOutsideQuotes(text, /(?:^|[;&|]\s*)npm(?:\.cmd)?\s+test(?![:\w-])/)
  if (npm >= 0) return npm
  return indexOutsideQuotes(text, /(?:^|[;&|]\s*)(?:&\s*)?\.\\script\\test\.ps1(?:\s|;|$)/)
}

function packagingCommandOffset(line: string): number {
  const text = stripInlineComment(line)
  if (isWriteOrEcho(text)) return -1
  const npm = indexOutsideQuotes(
    text,
    /(?:^|[;&|]\s*)(?:&\s*)?npm(?:\.cmd)?\s+run\s+build:win(?:\s|;|$)/
  )
  if (npm >= 0) return npm
  return indexOutsideQuotes(
    text,
    /(?:^|[;&|]\s*)(?:npx\s+)?electron-builder(?!\.ya?ml\b)(?:\s|;|$)/
  )
}

function firstRunCommandIndex(
  lines: { index: number; text: string }[],
  offsetOf: (line: string) => number
): number {
  let best = -1
  for (const line of lines) {
    const rel = offsetOf(line.text)
    if (rel < 0) continue
    const abs = line.index + rel
    if (best < 0 || abs < best) best = abs
  }
  return best
}

function splitShellStatements(line: string): string[] {
  const statements: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    const next = line[i + 1]
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      current += ch
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      current += ch
      continue
    }
    if (!inSingle && !inDouble && ch === '&' && next === '&') {
      statements.push(current.trim())
      current = ''
      i += 1
      continue
    }
    if (!inSingle && !inDouble && ch === '|' && next === '|') {
      statements.push(current.trim())
      current = ''
      i += 1
      continue
    }
    if (!inSingle && !inDouble && ch === ';') {
      statements.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) statements.push(current.trim())
  return statements.filter((statement) => statement.length > 0)
}

function isPackagingStatement(statement: string): boolean {
  const text = stripInlineComment(statement).trim()
  if (!text || isWriteOrEcho(text)) return false
  const unprefixed = text.replace(/^(?:&|call)\s+/i, '')
  if (/^npm(?:\.cmd)?\s+run\s+build:win(?:\s|$)/.test(unprefixed)) return true
  return /^(?:npx\s+)?electron-builder(?!\.ya?ml\b)(?:\s|$)/.test(unprefixed)
}

function packagingStatementsFromRunLine(line: string): string[] {
  return splitShellStatements(stripInlineComment(line)).filter(isPackagingStatement)
}

function parseFilesMappingValue(inline: string, children: string[]): string[] {
  if (isBlockScalarIndicator(inline) || /^(?:[|>][+-]?)/.test(inline)) {
    return children.map(stripYamlQuotes).filter((item) => item.length > 0)
  }
  if (inline) {
    if (inline.startsWith('[')) return parseInlineYamlList(inline)
    if (inline.includes(',')) {
      return inline
        .split(',')
        .map((part) => stripYamlQuotes(part.trim()))
        .filter((part) => part.length > 0)
    }
    return [stripYamlQuotes(inline)]
  }
  const items: string[] = []
  for (const child of children) {
    if (child.startsWith('- ')) items.push(stripYamlQuotes(child.slice(2).trim()))
    else if (child.length > 0) items.push(stripYamlQuotes(child))
  }
  return items
}

function filesFromBlock(source: string): string[] {
  const lines = walkLines(source)
  const globs: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const stripped = stripInlineComment(lines[i].line)
    if (stripped.trim() === '' || stripped.trimStart().startsWith('#')) continue
    const match = stripped.match(/^([ \t]*)files:\s*(.*)$/)
    if (!match) continue

    const indent = match[1]
    const inline = match[2].trim()
    const children: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const childRaw = lines[j].line
      const child = stripInlineComment(childRaw)
      if (child.trim() === '') continue
      if (child.trimStart().startsWith('#')) continue
      const childIndent = childRaw.match(/^[ \t]*/)?.[0] ?? ''
      if (childIndent.length <= indent.length) break
      children.push(child.trim())
    }
    globs.push(...parseFilesMappingValue(inline, children))
  }
  return globs
}

function extractJobSteps(source: string): string[] {
  const lines = walkLines(source)
  const steps: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const stripped = stripInlineComment(lines[i].line)
    if (stripped.trim() === '' || stripped.trimStart().startsWith('#')) continue
    const stepsMatch = stripped.match(/^([ \t]*)steps:\s*$/)
    if (!stepsMatch) continue

    const stepsIndent = stepsMatch[1]
    let itemIndent: string | null = null
    let current: string[] = []

    const flush = (): void => {
      if (current.length === 0) return
      const first = current[0].replace(/^([ \t]*)-\s+/, '$1')
      steps.push([first, ...current.slice(1)].join('\n'))
      current = []
    }

    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j].line
      const child = stripInlineComment(raw)
      if (child.trim() === '' || child.trimStart().startsWith('#')) {
        if (current.length > 0) current.push(child)
        continue
      }
      const childIndent = raw.match(/^[ \t]*/)?.[0] ?? ''
      if (childIndent.length <= stepsIndent.length) break
      const dash = child.match(/^([ \t]*)-\s+/)
      if (dash) {
        if (itemIndent === null) itemIndent = dash[1]
        if (dash[1] === itemIndent) {
          flush()
          current.push(child)
          continue
        }
      }
      current.push(child)
    }
    flush()
  }
  return steps
}

/** `files:` lists from steps whose `uses` contains `action-gh-release`. */
function ghReleaseFileLists(source: string): string[][] {
  const lists: string[][] = []
  for (const step of extractJobSteps(source)) {
    const uses = yamlScalar(step, 'uses') ?? ''
    if (!uses.includes('action-gh-release')) continue
    lists.push(filesFromBlock(step))
  }
  return lists
}

function isSetupExeGlob(glob: string): boolean {
  const normalized = stripYamlQuotes(glob.trim())
  return /(?:\*setup\*\.exe|\*-setup\.exe)$/.test(normalized)
}

function isPortableExeGlob(glob: string): boolean {
  const normalized = stripYamlQuotes(glob.trim())
  return /(?:\*portable\*\.exe|\*-portable\.exe)$/.test(normalized)
}

function canMatchExeBlockmap(glob: string): boolean {
  if (glob.trim().startsWith('!')) return false
  const normalized = stripYamlQuotes(glob.trim())
  return normalized.includes('.blockmap') || /\.exe\*/.test(normalized)
}

function hasBlockmapExclusion(globs: string[]): boolean {
  return globs.some((glob) => /^\s*!.*\.blockmap/.test(glob))
}

function isOverlyBroadUploadGlob(glob: string): boolean {
  const normalized = glob.replace(/\\/g, '/').replace(/\/+$/, '').trim()
  if (normalized.startsWith('!')) return false
  return (
    normalized === '*' ||
    normalized === '**' ||
    normalized === '**/*' ||
    normalized === 'dist/*' ||
    normalized === 'dist/**' ||
    normalized === 'dist/**/*' ||
    /\/\*\*$/.test(normalized) ||
    /\/\*$/.test(normalized)
  )
}

/** setup-node spec that satisfies jsdom 30 (`^22.22.2 || ^24.15.0 || >=26.0.0`). */
function isJsdom30CompatibleNodeSpec(spec: string): boolean {
  const trimmed = spec.trim()
  if (trimmed === '26' || /^26\./.test(trimmed)) return true
  if (/^24\.(1[5-9]|[2-9]\d)(?:\.|$)/.test(trimmed)) return true
  if (/^22\.(22\.(?:[2-9]|\d{2,})|2[3-9]|[3-9]\d)(?:\.|$)/.test(trimmed)) return true
  return false
}

function isBuildWinInvocation(line: string): boolean {
  const stripped = stripInlineComment(line).trim()
  if (!stripped || isWriteOrEcho(stripped)) return false
  const unprefixed = stripped.replace(/^(?:&|call)\s+/i, '')
  return /^npm(?:\.cmd)?\s+run\s+build:win(?:\s|;|$)/.test(unprefixed)
}

describe('electron-builder.yml Windows release contract', () => {
  const yml = readRepoFile('electron-builder.yml')

  it('should list nsis and portable as the only win targets', () => {
    // covers: Test-172
    // Parse the win: block only so linux.target (AppImage/snap/deb) cannot satisfy this.
    const targets = winTargetNames(yamlBlock(yml, 'win'))
    expect([...targets].sort()).toEqual(['nsis', 'portable'])
  })

  it('should set NSIS oneClick, perMachine and allowElevation explicitly', () => {
    // covers: Test-173
    const nsis = yamlBlock(yml, 'nsis')
    expect(yamlScalar(nsis, 'oneClick')).toBe('true')
    expect(yamlScalar(nsis, 'perMachine')).toBe('false')
    expect(yamlScalar(nsis, 'allowElevation')).toBe('false')
  })

  it('should use the setup artifactName for NSIS', () => {
    // covers: Test-174
    expect(yamlScalar(yamlBlock(yml, 'nsis'), 'artifactName')).toBe(
      '${name}-${version}-setup.${ext}'
    )
  })

  it('should use the portable artifactName for portable', () => {
    // covers: Test-175
    expect(yamlScalar(yamlBlock(yml, 'portable'), 'artifactName')).toBe(
      '${name}-${version}-portable.${ext}'
    )
  })

  it('should restrict win arch to x64', () => {
    // covers: Test-176
    const win = yamlBlock(yml, 'win')
    const archValues = yamlListItems(win, 'arch')
    expect(archValues.length).toBeGreaterThan(0)
    expect(archValues.every((arch) => arch === 'x64')).toBe(true)
    expect(win).not.toMatch(/\bia32\b/)
    expect(win).not.toMatch(/\barm64\b/)
  })

  it('should not contain the example.com publish placeholder', () => {
    // covers: Test-177
    expect(yml).not.toContain('example.com')
  })

  it('should unpack sharp and its platform-specific native dependencies from ASAR', () => {
    const patterns = yamlListItems(yml, 'asarUnpack')
    expect(patterns).toContain('**/node_modules/sharp/**/*')
    expect(patterns).toContain('**/node_modules/@img/**/*')
  })
})

describe('.github/workflows/release.yml contract', () => {
  it('should trigger only on push tags v* and omit workflow_dispatch', () => {
    // covers: Test-178
    const workflow = readRepoFile('.github/workflows/release.yml')
    expect(uncommented(workflow)).not.toMatch(/^\s*workflow_dispatch\s*:/m)

    const onBlock = yamlBlock(workflow, 'on')
    expect(mappingKeys(onBlock)).toEqual(['push'])

    const pushBlock = yamlBlock(onBlock, 'push')
    expect(mappingKeys(pushBlock)).toEqual(['tags'])
    expect(yamlListItems(pushBlock, 'tags')).toEqual(['v*'])
  })

  it('should run only on windows-latest', () => {
    // covers: Test-179
    const workflow = readRepoFile('.github/workflows/release.yml')
    const body = uncommented(workflow)
    const runners = yamlListItems(body, 'runs-on')
    expect(runners.length).toBeGreaterThan(0)
    expect(runners.every((runner) => runner === 'windows-latest')).toBe(true)
    expect(body).not.toContain('macos-latest')
    expect(body).not.toContain('ubuntu-latest')
  })

  it('should run a test step before the packaging step', () => {
    // covers: Test-180
    const runLines = extractWorkflowRunLines(readRepoFile('.github/workflows/release.yml'))
    const testIdx = firstRunCommandIndex(runLines, testCommandOffset)
    const pkgIdx = firstRunCommandIndex(runLines, packagingCommandOffset)
    expect(testIdx).toBeGreaterThanOrEqual(0)
    expect(pkgIdx).toBeGreaterThanOrEqual(0)
    expect(testIdx).toBeLessThan(pkgIdx)
  })

  it('should pass --publish never to the packaging command', () => {
    // covers: Test-181
    const runLines = extractWorkflowRunLines(readRepoFile('.github/workflows/release.yml'))
    const packagingStatements = runLines.flatMap((line) =>
      packagingStatementsFromRunLine(line.text)
    )
    expect(packagingStatements.length).toBeGreaterThan(0)
    expect(packagingStatements.every((statement) => /--publish\s+never\b/.test(statement))).toBe(
      true
    )
  })

  it('should not create a draft release', () => {
    // covers: Test-182
    const body = walkLines(readRepoFile('.github/workflows/release.yml'))
      .map((entry) => stripInlineComment(entry.line))
      .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
      .join('\n')
    expect(body).not.toMatch(/^\s*draft:\s*(?:true|"true"|'true')\b/m)
  })

  it('should upload setup and portable exe globs and omit blockmaps', () => {
    // covers: Test-183
    const lists = ghReleaseFileLists(readRepoFile('.github/workflows/release.yml'))
    expect(lists.length).toBeGreaterThan(0)
    for (const globs of lists) {
      expect(globs.some(isSetupExeGlob)).toBe(true)
      expect(globs.some(isPortableExeGlob)).toBe(true)
      expect(globs.some(canMatchExeBlockmap)).toBe(false)
      const broad = globs.filter(isOverlyBroadUploadGlob)
      const unexcludedDoubleStar = broad.some((glob) => glob.includes('**'))
      expect(unexcludedDoubleStar && !hasBlockmapExclusion(globs)).toBe(false)
      expect(broad.some((glob) => !glob.includes('**'))).toBe(false)
    }
  })

  it('should pin a Node version that jsdom 30 can boot', () => {
    // covers: Test-185
    // jsdom 30 engines: ^22.22.2 || ^24.15.0 || >=26.0.0
    // Node 20 + undici 8 throws: webidl.util.markAsUncloneable is not a function
    const spec = yamlScalar(readRepoFile('.github/workflows/release.yml'), 'node-version')
    expect(spec).toBeDefined()
    expect(isJsdom30CompatibleNodeSpec(spec ?? '')).toBe(true)
  })
})

describe('script/package.ps1 contract', () => {
  it('should invoke npm run build:win', () => {
    // covers: Test-184
    const script = readRepoFile('script/package.ps1')
    const commandLines = script
      .split(/\r?\n/)
      .map((line) => stripInlineComment(line).trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
    expect(commandLines.some(isBuildWinInvocation)).toBe(true)
  })
})
