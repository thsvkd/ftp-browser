import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// LocalFileSystem imports `app` from electron only for getHomePath(), which these
// tests don't exercise. Mock it so the module imports cleanly under node.
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()) }
}))

import { LocalFileSystem } from './LocalFileSystem'

describe('LocalFileSystem', () => {
  let tmpDir: string
  let localFs: LocalFileSystem

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lfs-test-'))
    localFs = new LocalFileSystem()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('list', () => {
    it('returns hidden (dotfile) entries so the renderer can decide visibility', async () => {
      await fs.writeFile(path.join(tmpDir, 'visible.txt'), 'hi')
      await fs.writeFile(path.join(tmpDir, '.hidden'), 'secret')
      await fs.mkdir(path.join(tmpDir, '.config'))

      const result = await localFs.list(tmpDir)
      const names = result.entries.map((e) => e.name).sort()

      expect(names).toEqual(['.config', '.hidden', 'visible.txt'])
    })

    it('flags image files via isImage', async () => {
      await fs.writeFile(path.join(tmpDir, 'photo.JPG'), 'x')
      await fs.writeFile(path.join(tmpDir, 'note.txt'), 'x')

      const result = await localFs.list(tmpDir)
      const photo = result.entries.find((e) => e.name === 'photo.JPG')
      const note = result.entries.find((e) => e.name === 'note.txt')

      expect(photo?.isImage).toBe(true)
      expect(note?.isImage).toBe(false)
    })
  })

  describe('collectFiles', () => {
    it('recursively collects files with paths relative to the root and their sizes', async () => {
      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'aa') // 2 bytes
      await fs.mkdir(path.join(tmpDir, 'sub'))
      await fs.writeFile(path.join(tmpDir, 'sub', 'b.txt'), 'bbbb') // 4 bytes

      const files = await localFs.collectFiles(tmpDir)
      const byRel = Object.fromEntries(files.map((f) => [f.rel.replace(/\\/g, '/'), f.size]))

      expect(byRel).toEqual({ 'a.txt': 2, 'sub/b.txt': 4 })
    })

    it('returns an empty list for an empty directory', async () => {
      await fs.mkdir(path.join(tmpDir, 'empty'))
      const files = await localFs.collectFiles(path.join(tmpDir, 'empty'))
      expect(files).toEqual([])
    })
  })

  describe('copyFileWithProgress', () => {
    it('copies the file and reports the total bytes read', async () => {
      const src = path.join(tmpDir, 'src.bin')
      const dest = path.join(tmpDir, 'dest.bin')
      const content = Buffer.alloc(1024, 7)
      await fs.writeFile(src, content)

      let reported = 0
      await localFs.copyFileWithProgress(
        src,
        dest,
        (chunkLength) => {
          reported += chunkLength
        },
        () => false
      )

      expect(reported).toBe(1024)
      expect(await fs.readFile(dest)).toEqual(content)
    })

    it('aborts and removes the partial destination when cancelled', async () => {
      const src = path.join(tmpDir, 'big.bin')
      const dest = path.join(tmpDir, 'big-copy.bin')
      await fs.writeFile(src, Buffer.alloc(512 * 1024, 1))

      await expect(
        localFs.copyFileWithProgress(
          src,
          dest,
          () => undefined,
          () => true // cancel immediately on first chunk
        )
      ).rejects.toThrow('cancelled')

      await expect(fs.access(dest)).rejects.toThrow()
    })
  })

  describe('delete', () => {
    it('removes a file', async () => {
      const file = path.join(tmpDir, 'gone.txt')
      await fs.writeFile(file, 'x')
      await localFs.delete(file, false)
      await expect(fs.access(file)).rejects.toThrow()
    })

    it('removes a directory recursively', async () => {
      const dir = path.join(tmpDir, 'tree')
      await fs.mkdir(dir)
      await fs.writeFile(path.join(dir, 'inner.txt'), 'x')
      await localFs.delete(dir, true)
      await expect(fs.access(dir)).rejects.toThrow()
    })
  })
})
