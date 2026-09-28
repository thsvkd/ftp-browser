import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// rename 실패를 흉내 내기 위해 fs/promises의 rename만 바꿔 끼울 수 있게 둔다.
const renameOverride = vi.hoisted(() => ({
  fn: null as null | ((a: string, b: string) => Promise<void>)
}))
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const rename = (a: string, b: string): Promise<void> =>
    renameOverride.fn ? renameOverride.fn(a, b) : actual.rename(a, b)
  return { ...actual, default: { ...actual, rename }, rename }
})

import { movePartialIntoPlace, partialPathFor } from './partialFile'

describe('partialFile', () => {
  let tmpDir: string
  const realPlatform = process.platform

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'partial-test-'))
  })

  afterEach(async () => {
    renameOverride.fn = null
    Object.defineProperty(process, 'platform', { value: realPlatform })
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('keeps the partial name short and hidden next to the target, whatever its length', () => {
    // 이름 길이 한도(255)에 가까운 원본 이름에 접미사를 붙이면 ENAMETOOLONG이 난다.
    const target = path.join(tmpDir, 'a'.repeat(250) + '.jpg')
    const partial = partialPathFor(target)

    expect(path.dirname(partial)).toBe(tmpDir)
    expect(path.basename(partial)).toMatch(/^\.ftp-browser-[0-9a-f]{8}\.part$/)
  })

  it.skipIf(process.platform === 'win32')(
    'keeps the permission bits of the file it replaces',
    async () => {
      const target = path.join(tmpDir, 'run.sh')
      await fs.writeFile(target, 'old')
      await fs.chmod(target, 0o755)
      const partial = partialPathFor(target)
      await fs.writeFile(partial, 'new')

      await movePartialIntoPlace(partial, target)

      expect(await fs.readFile(target, 'utf8')).toBe('new')
      expect((await fs.stat(target)).mode & 0o777).toBe(0o755)
    }
  )

  it('retries a rename that Windows reports as busy', async () => {
    // 백신·인덱서가 방금 닫힌 파일을 잠깐 잡고 있으면 rename이 EBUSY/EPERM으로 실패한다.
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const target = path.join(tmpDir, 'photo.jpg')
    const partial = partialPathFor(target)
    await fs.writeFile(partial, 'data')
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    let calls = 0
    renameOverride.fn = async (a, b) => {
      calls++
      if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return actual.rename(a, b)
    }

    await movePartialIntoPlace(partial, target)

    expect(calls).toBe(3)
    expect(await fs.readFile(target, 'utf8')).toBe('data')
  })

  it('does not retry on other platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const target = path.join(tmpDir, 'photo.jpg')
    const partial = partialPathFor(target)
    await fs.writeFile(partial, 'data')
    let calls = 0
    renameOverride.fn = async () => {
      calls++
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    }

    await expect(movePartialIntoPlace(partial, target)).rejects.toThrow('busy')
    expect(calls).toBe(1)
  })
})
