import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// npm test / setup scripts run from the repo root.
const repoRoot = process.cwd()

describe('renderer shell (index.html)', () => {
  it("keeps img-src and adds media-src 'self' data: to the CSP", () => {
    // covers: Test-882
    const html = fs.readFileSync(path.join(repoRoot, 'src/renderer/index.html'), 'utf8')
    const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)?.[1] ?? ''
    expect(policy).toContain("img-src 'self' data:")
    expect(policy).toContain("media-src 'self' data:")
  })
})
