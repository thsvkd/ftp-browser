/* eslint-disable @typescript-eslint/explicit-function-return-type -- Vitest executes this JavaScript harness directly. */

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildCli } from './build-cli.mjs'

const dirs = []

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('build-cli', () => {
  it('bundles ftpb into one file that runs --help from anywhere with Node built-ins only', async () => {
    // covers: Test-557
    const outDir = tempDir('ftpb-build-')

    await buildCli({ outDir })

    expect(readdirSync(outDir)).toEqual(['ftpb.cjs'])
    const source = readFileSync(path.join(outDir, 'ftpb.cjs'), 'utf8')
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true)
    const required = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
    const builtins = new Set(builtinModules)
    for (const id of required) expect(builtins.has(id.replace(/^node:/, '')), id).toBe(true)

    // 빌드 폴더와 node_modules에서 떨어진 곳으로 옮겨도 돈다
    const elsewhere = tempDir('ftpb-copy-')
    copyFileSync(path.join(outDir, 'ftpb.cjs'), path.join(elsewhere, 'ftpb.cjs'))
    const run = spawnSync(process.execPath, [path.join(elsewhere, 'ftpb.cjs'), '--help'], {
      cwd: elsewhere,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' }
    })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Exit codes')
    expect(run.stdout).toContain('ftpb tools')
  }, 60_000)
})
