import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function activeLines(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

function matrixRows(source: string): Array<{ os: string; target: string; arch: string }> {
  const rows: Array<{ os: string; target: string; arch: string }> = []
  const lines = source.split(/\r?\n/)

  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s*-\s+os:\s*([^\s#]+)\s*$/)
    if (!match) continue

    const row = { os: match[1], target: '', arch: '' }
    for (let child = index + 1; child < lines.length; child++) {
      if (/^\s*-\s+os:/.test(lines[child])) break
      const target = lines[child].match(/^\s+target:\s*([^\s#]+)\s*$/)
      const arch = lines[child].match(/^\s+arch:\s*([^\s#]+)\s*$/)
      if (target) row.target = target[1]
      if (arch) row.arch = arch[1]
    }
    rows.push(row)
  }

  return rows
}

describe('cross-platform CI workflow contract', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml')
  const lines = activeLines(workflow)
  const body = lines.join('\n')

  it('should run directly for changes and be reusable by releases', () => {
    expect(body).toContain('workflow_call:')
    expect(body).toContain('pull_request:')
    expect(body).toContain('push:')
    expect(body).toContain('branches: [main]')
  })

  it('should test every native OS and architecture distributed in releases', () => {
    expect(matrixRows(workflow)).toEqual([
      { os: 'windows-latest', target: 'win', arch: 'x64' },
      { os: 'ubuntu-latest', target: 'linux', arch: 'x64' },
      { os: 'macos-15', target: 'mac', arch: 'arm64' },
      { os: 'macos-15-intel', target: 'mac', arch: 'x64' }
    ])
    expect(body).toContain('runs-on: ${{ matrix.os }}')
    expect(body).not.toContain('continue-on-error: true')
  })

  it('should install, test, package and smoke in that order', () => {
    const install = body.indexOf('run: npm ci')
    const test = body.indexOf('run: npm test')
    const packageApp = body.indexOf('run: npm run build:unpack')
    const smoke = body.indexOf('npm run smoke:packaged')

    expect(install).toBeGreaterThanOrEqual(0)
    expect(test).toBeGreaterThan(install)
    expect(packageApp).toBeGreaterThan(test)
    expect(smoke).toBeGreaterThan(packageApp)
  })

  it('should package an explicit target and architecture without publishing', () => {
    const packageCommand = lines.find((line) => line.startsWith('run: npm run build:unpack'))
    expect(packageCommand).toContain('--${{ matrix.target }}')
    expect(packageCommand).toContain('--${{ matrix.arch }}')
    expect(packageCommand).toContain('--publish never')
  })

  it('should run Linux Electron under Xvfb and bound every job', () => {
    expect(body).toContain("if: runner.os == 'Linux'")
    expect(body).toContain('run: xvfb-run --auto-servernum npm run smoke:packaged')
    expect(body).toContain('timeout-minutes: 30')
  })

  it('should use read-only permissions and the repository Node version', () => {
    expect(body).toContain('contents: read')
    expect(body).toContain('node-version: 24.15.0')
    expect(body).toContain('cache: npm')
  })

  it('should use the Node 24-based official setup actions', () => {
    expect(body).toContain('uses: actions/checkout@v7')
    expect(body).toContain('uses: actions/setup-node@v7')
    expect(body).not.toMatch(/uses: actions\/(?:checkout|setup-node)@v4/)
  })
})

describe('release verification contract', () => {
  const source = readRepoFile('.github/workflows/release.yml')
  const workflow = activeLines(source).join('\n')

  it('should wait for the reusable cross-platform verification workflow', () => {
    expect(workflow).toContain('uses: ./.github/workflows/ci.yml')
    expect(workflow).toContain('needs: verify')
  })

  it('should build every release artifact on its native OS and architecture', () => {
    expect(matrixRows(source)).toEqual([
      { os: 'windows-latest', target: 'win', arch: 'x64' },
      { os: 'macos-15', target: 'mac', arch: 'arm64' },
      { os: 'macos-15-intel', target: 'mac', arch: 'x64' },
      { os: 'ubuntu-latest', target: 'linux', arch: 'x64' }
    ])
    expect(workflow).toContain('runs-on: ${{ matrix.os }}')
    expect(workflow).not.toContain('continue-on-error: true')
  })

  it('should collect platform artifacts and publish them in one final job', () => {
    expect(workflow).toContain('uses: actions/upload-artifact@v7')
    expect(workflow).toContain('uses: actions/download-artifact@v8')
    expect(workflow).toContain('merge-multiple: true')
    expect(workflow.match(/uses: softprops\/action-gh-release@v3/g)).toHaveLength(1)
    expect(source).toMatch(/publish-release:\s*\n\s+needs: build-release/)
  })

  it('should bind each release target to its native packaging command', () => {
    expect(workflow).toContain(
      "if: matrix.target == 'win'\nrun: npm run build:win -- --x64 --publish never"
    )
    expect(workflow).toContain(
      "if: matrix.target == 'mac'\nrun: npm run build:mac -- dmg zip --${{ matrix.arch }} --publish never"
    )
    expect(workflow).toContain(
      "if: matrix.target == 'linux'\nrun: npm run build:linux -- AppImage deb --x64 --publish never"
    )
    expect(workflow).toContain('if-no-files-found: error')
  })

  it('should serialize releases that target the same tag', () => {
    expect(workflow).toContain('group: release-${{ github.ref }}')
    expect(workflow).toContain('cancel-in-progress: false')
  })

  it('should use the supported release action and replace assets for a reused tag', () => {
    expect(workflow).toContain('uses: softprops/action-gh-release@v3')
    expect(workflow).toContain('overwrite_files: true')
    expect(workflow).not.toContain('uses: softprops/action-gh-release@v2')
  })

  it('should use the Node 24-based official setup actions', () => {
    expect(workflow).toContain('uses: actions/checkout@v7')
    expect(workflow).toContain('uses: actions/setup-node@v7')
    expect(workflow).not.toMatch(/uses: actions\/(?:checkout|setup-node)@v4/)
  })
})

describe('packaged smoke command contract', () => {
  it('should expose the bounded packaged-app runner through npm', () => {
    const packageJson = JSON.parse(readRepoFile('package.json')) as {
      scripts?: Record<string, string>
    }
    expect(packageJson.scripts?.['smoke:packaged']).toBe('node script/smoke-packaged.mjs')
    expect(readRepoFile('script/smoke-packaged.mjs')).toContain('--smoke-test')
  })
})
