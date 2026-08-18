import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// npm test / setup scripts run from the repo root.
const repoRoot = process.cwd()

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function readPackageJson(): {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
} {
  return JSON.parse(readRepoFile('package.json')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    scripts?: Record<string, string>
  }
}

/**
 * First explicit numeric version range. `^43.4.0` / `~43.4.0` / `43.4.0` pin
 * major 43. An unbounded comparator (`>=43`, `>42.0.0`) does not pin a major.
 */
function firstNumericRange(spec: string): { major: number; minor?: number } | undefined {
  const first =
    spec
      .trim()
      .split(/\s*\|\|\s*/)[0]
      ?.trim() ?? ''
  if (!first) return undefined

  const hasUpperBound = /(?:\s+<\s*|\s+<=\s*|\s+-\s+)/.test(first)
  if (/^[><]=?/.test(first) && !hasUpperBound) return undefined

  const match = first.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? undefined : Number(match[2])
  }
}

function packageSpec(
  pkg: ReturnType<typeof readPackageJson>,
  section: 'dependencies' | 'devDependencies',
  name: string
): string {
  const spec = pkg[section]?.[name]
  expect(spec, `${section}.${name}`).toEqual(expect.any(String))
  return spec as string
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

/** Replace PowerShell `<# ... #>` blocks with spaces so they cannot parse as code. */
function stripPsBlockComments(source: string): string {
  let out = ''
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    const next = source[i + 1]
    if (!inSingle && !inDouble && ch === '<' && next === '#') {
      const end = source.indexOf('#>', i + 2)
      const stop = end === -1 ? source.length : end + 2
      out += source.slice(i, stop).replace(/[^\r\n]/g, ' ')
      i = stop - 1
      continue
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    out += ch
  }
  return out
}

function commandText(line: string): string {
  return stripInlineComment(line)
    .trim()
    .replace(/^(?:&|\.|call)\s+/i, '')
}

function isPrintOnly(line: string): boolean {
  return /^(?:Write-Host|Write-Output|Write-Info|Write-Ok|Write-Skip|Write-Fail|echo|info|ok|warn|fail)\b/i.test(
    commandText(line)
  )
}

function executableText(source: string, flavor: 'sh' | 'ps1' = 'sh'): string {
  const prepared = flavor === 'ps1' ? stripPsBlockComments(source) : source
  return prepared
    .split(/\r?\n/)
    .map((line) => stripInlineComment(line))
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
    .join('\n')
}

function withoutPrintOnly(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !isPrintOnly(line))
    .join('\n')
}

function normalizeSlashes(text: string): string {
  return text.replace(/\\/g, '/')
}

function hasElectronPathTxtAbsence(text: string): boolean {
  const n = normalizeSlashes(text)
  if (/!\s*-f\s+["']?[^\s"']*electron\/path\.txt/.test(n)) return true
  if (/!\s*-e\s+["']?[^\s"']*electron\/path\.txt/.test(n)) return true
  if (/!\s+test\s+-f\s+["']?[^\s"']*electron\/path\.txt/.test(n)) return true
  if (/-\s*not\s*\(\s*Test-Path\b[\s\S]{0,120}?electron\/path\.txt/i.test(n)) return true
  if (/!\s*\(\s*Test-Path\b[\s\S]{0,120}?electron\/path\.txt/i.test(n)) return true
  return false
}

function hasElectronPathTxtPresence(text: string): boolean {
  if (hasElectronPathTxtAbsence(text)) return false
  const n = normalizeSlashes(text)
  if (/\[\s*-f\s+["']?[^\s"']*electron\/path\.txt/.test(n)) return true
  if (/\[\s*-e\s+["']?[^\s"']*electron\/path\.txt/.test(n)) return true
  if (/\btest\s+-f\s+["']?[^\s"']*electron\/path\.txt/.test(n)) return true
  if (/Test-Path\b[\s\S]{0,120}?electron\/path\.txt/i.test(n)) return true
  return false
}

function hasNodeElectronInstallJs(text: string): boolean {
  const n = normalizeSlashes(withoutPrintOnly(text))
  return /\b(?:&\s*)?node(?:\.exe)?\s+(?:"[^"]*electron\/install\.js"|'[^']*electron\/install\.js'|\S*electron\/install\.js)/.test(
    n
  )
}

function hasBetterSqlite3NodeAbsence(text: string): boolean {
  const n = normalizeSlashes(text)
  if (/!\s*-f\s+["']?[^\s"']*better-sqlite3\/build\/Release\/better_sqlite3\.node/.test(n)) {
    return true
  }
  if (
    /-\s*not\s*\(\s*Test-Path\b[\s\S]{0,160}?better-sqlite3\/build\/Release\/better_sqlite3\.node/i.test(
      n
    )
  ) {
    return true
  }
  if (
    /!\s*\(\s*Test-Path\b[\s\S]{0,160}?better-sqlite3\/build\/Release\/better_sqlite3\.node/i.test(
      n
    )
  ) {
    return true
  }
  return false
}

function hasBetterSqlite3NodePresence(text: string): boolean {
  if (hasBetterSqlite3NodeAbsence(text)) return false
  const n = normalizeSlashes(text)
  if (/\[\s*-f\s+["']?[^\s"']*better-sqlite3\/build\/Release\/better_sqlite3\.node/.test(n)) {
    return true
  }
  if (/Test-Path\b[\s\S]{0,160}?better-sqlite3\/build\/Release\/better_sqlite3\.node/i.test(n)) {
    return true
  }
  return false
}

function isInstallAppDepsInvocation(line: string): boolean {
  if (isPrintOnly(line)) return false
  return /^(?:npx\s+)?electron-builder\s+install-app-deps\b/.test(commandText(line))
}

function hasInstallAppDeps(text: string): boolean {
  return text.split(/\r?\n/).some((line) => isInstallAppDepsInvocation(line))
}

interface IfBlock {
  condition: string
  thenBody: string
  elseBody: string
  parent: IfBlock | null
  inParentElse: boolean
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch)
}

function startsWord(text: string, index: number, word: string): boolean {
  if (!text.startsWith(word, index)) return false
  if (index > 0 && isWordChar(text[index - 1])) return false
  const after = index + word.length
  if (after < text.length && isWordChar(text[after])) return false
  return true
}

function nextBareKeyword(
  text: string,
  from: number,
  keywords: string[]
): { index: number; word: string } | null {
  let inSingle = false
  let inDouble = false
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && (inSingle || inDouble)) {
      i += 1
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (inSingle || inDouble) continue
    for (const word of keywords) {
      if (!startsWord(text, i, word)) continue
      if (word === 'if' && i >= 2 && text.slice(i - 2, i) === 'el') continue
      return { index: i, word }
    }
  }
  return null
}

function parseBashThenElse(
  text: string,
  from: number
): { thenBody: string; elseBody: string; end: number } {
  let depth = 0
  let elseAt = -1
  let inSingle = false
  let inDouble = false
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (inSingle || inDouble) continue

    if (startsWord(text, i, 'if') && !(i >= 2 && text.slice(i - 2, i) === 'el')) {
      depth += 1
      continue
    }
    if (startsWord(text, i, 'fi')) {
      if (depth === 0) {
        const thenBody = elseAt === -1 ? text.slice(from, i) : text.slice(from, elseAt)
        const elseBody = elseAt === -1 ? '' : text.slice(elseBodyStart(text, elseAt), i)
        return { thenBody, elseBody, end: i + 2 }
      }
      depth -= 1
      continue
    }
    if (
      depth === 0 &&
      elseAt === -1 &&
      (startsWord(text, i, 'else') || startsWord(text, i, 'elif'))
    ) {
      elseAt = i
    }
  }
  return { thenBody: text.slice(from), elseBody: '', end: text.length }
}

function elseBodyStart(text: string, elseAt: number): number {
  if (startsWord(text, elseAt, 'elif')) {
    const thenKw = nextBareKeyword(text, elseAt + 4, ['then'])
    return thenKw ? thenKw.index + 4 : elseAt + 4
  }
  return elseAt + 4
}

function collectBashIfBlocks(
  text: string,
  parent: IfBlock | null = null,
  inParentElse = false,
  acc: IfBlock[] = []
): IfBlock[] {
  let i = 0
  while (i < text.length) {
    const found = nextBareKeyword(text, i, ['if'])
    if (!found) break
    const thenKw = nextBareKeyword(text, found.index + 2, ['then'])
    if (!thenKw) {
      i = found.index + 2
      continue
    }
    const condition = text.slice(found.index + 2, thenKw.index).replace(/^[\s;]+|[\s;]+$/g, '')
    const { thenBody, elseBody, end } = parseBashThenElse(text, thenKw.index + 4)
    const block: IfBlock = { condition, thenBody, elseBody, parent, inParentElse }
    acc.push(block)
    collectBashIfBlocks(thenBody, block, false, acc)
    collectBashIfBlocks(elseBody, block, true, acc)
    i = end
  }
  return acc
}

function matchPaired(text: string, openIndex: number, open: string, close: string): number {
  let depth = 0
  let inSingle = false
  let inDouble = false
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (inSingle || inDouble) continue
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function collectPsIfBlocks(
  text: string,
  parent: IfBlock | null = null,
  inParentElse = false,
  acc: IfBlock[] = []
): IfBlock[] {
  let i = 0
  while (i < text.length) {
    const found = nextBareKeyword(text, i, ['if'])
    if (!found) break
    let j = found.index + 2
    while (j < text.length && /\s/.test(text[j])) j += 1
    if (text[j] !== '(') {
      i = found.index + 2
      continue
    }
    const condEnd = matchPaired(text, j, '(', ')')
    if (condEnd < 0) {
      i = found.index + 2
      continue
    }
    let k = condEnd + 1
    while (k < text.length && /\s/.test(text[k])) k += 1
    if (text[k] !== '{') {
      i = found.index + 2
      continue
    }
    const thenEnd = matchPaired(text, k, '{', '}')
    if (thenEnd < 0) {
      i = found.index + 2
      continue
    }
    const condition = text.slice(j + 1, condEnd)
    const thenBody = text.slice(k + 1, thenEnd)
    let elseBody = ''
    let next = thenEnd + 1
    let p = next
    while (p < text.length && /\s/.test(text[p])) p += 1
    if (startsWord(text, p, 'else')) {
      let q = p + 4
      while (q < text.length && /\s/.test(text[q])) q += 1
      if (text[q] === '{') {
        const elseEnd = matchPaired(text, q, '{', '}')
        if (elseEnd >= 0) {
          elseBody = text.slice(q + 1, elseEnd)
          next = elseEnd + 1
        }
      }
    }
    const block: IfBlock = { condition, thenBody, elseBody, parent, inParentElse }
    acc.push(block)
    collectPsIfBlocks(thenBody, block, false, acc)
    collectPsIfBlocks(elseBody, block, true, acc)
    i = next
  }
  return acc
}

function requiresNodeModulesAbsent(condition: string, flavor: 'sh' | 'ps1'): boolean {
  // A path.txt / electron-binary check is not the node_modules directory gate.
  if (hasElectronPathTxtAbsence(condition) || hasElectronPathTxtPresence(condition)) {
    return false
  }
  const n = normalizeSlashes(condition)
  if (flavor === 'sh') {
    return (
      /\[\s*!\s*-d\s+["']?node_modules["']?/.test(n) ||
      /!\s*\[\s*-d\s+["']?node_modules["']?/.test(n)
    )
  }
  return (
    /-\s*not\s*\(\s*Test-Path\b[\s\S]{0,80}?["']?node_modules["']?(?:\/|"|'|\s|\))/i.test(n) ||
    /!\s*\(\s*Test-Path\b[\s\S]{0,80}?["']?node_modules["']?(?:\/|"|'|\s|\))/i.test(n)
  )
}

function testsNodeModulesPresent(condition: string, flavor: 'sh' | 'ps1'): boolean {
  if (requiresNodeModulesAbsent(condition, flavor)) return false
  if (hasElectronPathTxtAbsence(condition) || hasElectronPathTxtPresence(condition)) {
    return false
  }
  const n = normalizeSlashes(condition)
  if (flavor === 'sh') return /\[\s*-d\s+["']?node_modules["']?/.test(n)
  return /Test-Path\b[\s\S]{0,80}?["']?node_modules["']?(?:\/|"|'|\s|\))/i.test(n)
}

function isReachableWhenNodeModulesExists(block: IfBlock, flavor: 'sh' | 'ps1'): boolean {
  if (requiresNodeModulesAbsent(block.condition, flavor)) return false
  let current: IfBlock | null = block
  while (current !== null && current.parent) {
    const parent = current.parent
    if (current.inParentElse && testsNodeModulesPresent(parent.condition, flavor)) return false
    if (!current.inParentElse && requiresNodeModulesAbsent(parent.condition, flavor)) return false
    current = parent
  }
  return true
}

function collectIfBlocks(source: string, flavor: 'sh' | 'ps1'): IfBlock[] {
  const exec = executableText(source, flavor)
  return flavor === 'sh' ? collectBashIfBlocks(exec) : collectPsIfBlocks(exec)
}

function hasElectronInstallBranch(source: string, flavor: 'sh' | 'ps1'): boolean {
  return collectIfBlocks(source, flavor).some((block) => {
    if (!isReachableWhenNodeModulesExists(block, flavor)) return false
    const absenceThen =
      hasElectronPathTxtAbsence(block.condition) && hasNodeElectronInstallJs(block.thenBody)
    const presenceElse =
      hasElectronPathTxtPresence(block.condition) && hasNodeElectronInstallJs(block.elseBody)
    return absenceThen || presenceElse
  })
}

function assignedFalseFlags(body: string, flavor: 'sh' | 'ps1'): string[] {
  const names: string[] = []
  for (const line of body.split(/\r?\n/)) {
    if (isPrintOnly(line)) continue
    const text = commandText(line)
    if (flavor === 'sh') {
      const match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)=(?:false|0)\s*$/i)
      if (match) names.push(match[1])
      continue
    }
    const match = text.match(/^\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\$false\b/i)
    if (match) names.push(match[1].toLowerCase())
  }
  return names
}

function flagSetByMissingSqliteNode(block: IfBlock, flavor: 'sh' | 'ps1'): string[] {
  if (hasBetterSqlite3NodeAbsence(block.condition)) {
    return assignedFalseFlags(block.thenBody, flavor)
  }
  if (hasBetterSqlite3NodePresence(block.condition)) {
    return assignedFalseFlags(block.elseBody, flavor)
  }
  return []
}

function bashFlagTest(condition: string): { name: string; polarity: 'true' | 'false' } | null {
  const n = condition.trim()
  const eqTrue = n.match(/\[\s*"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?\s*={1,2}\s*"?true"?\s*\]/)
  if (eqTrue) return { name: eqTrue[1], polarity: 'true' }
  const eqFalse = n.match(/\[\s*"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?\s*={1,2}\s*"?false"?\s*\]/)
  if (eqFalse) return { name: eqFalse[1], polarity: 'false' }
  const neTrue = n.match(/\[\s*"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?\s*!=\s*"?true"?\s*\]/)
  if (neTrue) return { name: neTrue[1], polarity: 'false' }
  return null
}

function psFlagTest(condition: string): { name: string; polarity: 'true' | 'false' } | null {
  const n = condition.trim()
  let match = n.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/)
  if (match) return { name: match[1].toLowerCase(), polarity: 'true' }
  match = n.match(/^(?:-not|!)\s+\$([A-Za-z_][A-Za-z0-9_]*)$/i)
  if (match) return { name: match[1].toLowerCase(), polarity: 'false' }
  match = n.match(/^(?:-not|!)\s*\(\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*\)$/i)
  if (match) return { name: match[1].toLowerCase(), polarity: 'false' }
  match = n.match(/^\$([A-Za-z_][A-Za-z0-9_]*)\s+-eq\s+\$true$/i)
  if (match) return { name: match[1].toLowerCase(), polarity: 'true' }
  match = n.match(/^\$([A-Za-z_][A-Za-z0-9_]*)\s+-eq\s+\$false$/i)
  if (match) return { name: match[1].toLowerCase(), polarity: 'false' }
  return null
}

function flagTest(
  condition: string,
  flavor: 'sh' | 'ps1'
): { name: string; polarity: 'true' | 'false' } | null {
  return flavor === 'sh' ? bashFlagTest(condition) : psFlagTest(condition)
}

function hasDirectNativeRebuild(block: IfBlock): boolean {
  if (hasBetterSqlite3NodeAbsence(block.condition) && hasInstallAppDeps(block.thenBody)) return true
  if (hasBetterSqlite3NodePresence(block.condition) && hasInstallAppDeps(block.elseBody))
    return true
  return false
}

function hasNativeRebuildLink(source: string, flavor: 'sh' | 'ps1'): boolean {
  const blocks = collectIfBlocks(source, flavor)
  if (blocks.some((block) => hasDirectNativeRebuild(block))) return true

  const flags = new Set<string>()
  for (const block of blocks) {
    for (const name of flagSetByMissingSqliteNode(block, flavor)) flags.add(name)
  }
  if (flags.size === 0) return false

  return blocks.some((block) => {
    const tested = flagTest(block.condition, flavor)
    if (!tested || !flags.has(tested.name)) return false
    if (tested.polarity === 'false' && hasInstallAppDeps(block.thenBody)) return true
    if (tested.polarity === 'true' && hasInstallAppDeps(block.elseBody)) return true
    return false
  })
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

function isElectronInstallJsStatement(statement: string): boolean {
  return hasNodeElectronInstallJs(statement)
}

function isInstallAppDepsStatement(statement: string): boolean {
  return hasInstallAppDeps(statement)
}

describe('runtime stack dependency contract', () => {
  it('should pin electron to major version 43', () => {
    // covers: Test-186
    const spec = packageSpec(readPackageJson(), 'devDependencies', 'electron')
    expect(firstNumericRange(spec)?.major).toBe(43)
  })

  it('should pin better-sqlite3 to major version 13', () => {
    // covers: Test-187
    const spec = packageSpec(readPackageJson(), 'dependencies', 'better-sqlite3')
    expect(firstNumericRange(spec)?.major).toBe(13)
  })

  it('should pin sharp to major 0 and minor 35 or higher', () => {
    // covers: Test-188
    const spec = packageSpec(readPackageJson(), 'dependencies', 'sharp')
    const range = firstNumericRange(spec)
    expect(range?.major).toBe(0)
    expect(range?.minor).toBeGreaterThanOrEqual(35)
  })

  it('should pin electron-vite to major version 5', () => {
    // covers: Test-189
    const spec = packageSpec(readPackageJson(), 'devDependencies', 'electron-vite')
    expect(firstNumericRange(spec)?.major).toBe(5)
  })

  it('should run electron install.js before electron-builder install-app-deps in postinstall', () => {
    // covers: Test-190
    const postinstall = readPackageJson().scripts?.postinstall ?? ''
    const statements = splitShellStatements(postinstall)
    const installJs = statements.findIndex(isElectronInstallJsStatement)
    const appDeps = statements.findIndex(isInstallAppDepsStatement)
    expect(installJs).toBeGreaterThanOrEqual(0)
    expect(appDeps).toBeGreaterThanOrEqual(0)
    expect(installJs).toBeLessThan(appDeps)
  })
})

describe('setup script electron path.txt contract', () => {
  it('should run electron install.js from setup.sh when path.txt is missing even if node_modules exists', () => {
    // covers: Test-191
    expect(hasElectronInstallBranch(readRepoFile('script/setup.sh'), 'sh')).toBe(true)
  })

  it('should run electron install.js from setup.ps1 when path.txt is missing even if node_modules exists', () => {
    // covers: Test-192
    expect(hasElectronInstallBranch(readRepoFile('script/setup.ps1'), 'ps1')).toBe(true)
  })
})

describe('setup script native rebuild contract', () => {
  it('should rebuild native modules from setup.sh when better_sqlite3.node is missing', () => {
    // covers: Test-193
    expect(hasNativeRebuildLink(readRepoFile('script/setup.sh'), 'sh')).toBe(true)
  })

  it('should rebuild native modules from setup.ps1 when better_sqlite3.node is missing', () => {
    // covers: Test-194
    expect(hasNativeRebuildLink(readRepoFile('script/setup.ps1'), 'ps1')).toBe(true)
  })
})

describe('setup script contract helpers', () => {
  it('should treat Write-Info as print-only so it is not an electron install branch', () => {
    const script = `
if (-not (Test-Path "node_modules\\electron\\path.txt")) {
    Write-Info "node node_modules/electron/install.js"
}
`
    expect(hasElectronInstallBranch(script, 'ps1')).toBe(false)
  })

  it('should ignore a PowerShell block comment that only mentions install.js', () => {
    const script = `
<#
if (-not (Test-Path "node_modules\\electron\\path.txt")) {
    node node_modules/electron/install.js
}
#>
`
    expect(hasElectronInstallBranch(script, 'ps1')).toBe(false)
  })

  it('should accept a bash path.txt-present else-install branch', () => {
    const script = `
if [ -f "node_modules/electron/path.txt" ]; then
  :
else
  node node_modules/electron/install.js
fi
`
    expect(hasElectronInstallBranch(script, 'sh')).toBe(true)
  })

  it('should accept a PowerShell path.txt-present else-install branch', () => {
    const script = `
if (Test-Path "node_modules\\electron\\path.txt") {
} else {
    node node_modules\\electron\\install.js
}
`
    expect(hasElectronInstallBranch(script, 'ps1')).toBe(true)
  })

  it('should not treat Write-Info mentioning install-app-deps as a rebuild', () => {
    const script = `
if (-not (Test-Path "node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node")) {
    $nativeOk = $false
}
if ($nativeOk) {
    Write-Skip "ok"
} else {
    Write-Info "npx electron-builder install-app-deps"
}
`
    expect(hasNativeRebuildLink(script, 'ps1')).toBe(false)
  })

  it('should require the missing better_sqlite3.node check to gate the rebuild', () => {
    const unlinked = `
if (-not (Test-Path "node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node")) {
    Write-Skip "missing"
}
& npx electron-builder install-app-deps
`
    expect(hasNativeRebuildLink(unlinked, 'ps1')).toBe(false)
  })
})
