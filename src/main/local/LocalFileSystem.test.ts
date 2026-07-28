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

  describe('rename', () => {
    it('renames a file', async () => {
      // covers: Test-61
      const oldPath = path.join(tmpDir, 'before.txt')
      const newPath = path.join(tmpDir, 'after.txt')
      await fs.writeFile(oldPath, 'payload')

      await localFs.rename(oldPath, newPath)

      await expect(fs.access(oldPath)).rejects.toThrow()
      expect(await fs.readFile(newPath, 'utf8')).toBe('payload')
    })

    it('renames a directory', async () => {
      // covers: Test-62
      const oldPath = path.join(tmpDir, 'before-dir')
      const newPath = path.join(tmpDir, 'after-dir')
      await fs.mkdir(oldPath)
      await fs.writeFile(path.join(oldPath, 'inner.txt'), 'kept')

      await localFs.rename(oldPath, newPath)

      await expect(fs.access(oldPath)).rejects.toThrow()
      expect((await fs.stat(newPath)).isDirectory()).toBe(true)
      expect(await fs.readFile(path.join(newPath, 'inner.txt'), 'utf8')).toBe('kept')
    })

    it('fails without overwriting when the target name already exists', async () => {
      // covers: Test-63
      const oldPath = path.join(tmpDir, 'source.txt')
      const newPath = path.join(tmpDir, 'occupied.txt')
      await fs.writeFile(oldPath, 'source content')
      await fs.writeFile(newPath, 'existing content')

      // 메시지까지 단언하는 이유: 거부의 출처를 고정하기 위함이다. 맨 toThrow()는
      // 우리가 심은 가드가 아니라 우발적인 OS 에러(권한, 잠긴 파일, 디렉터리 대상
      // 등)로도 만족되므로, 계약(§6)이 고정한 `Target already exists: <basename>`을
      // 요구해 의도한 경로로 거부되었음을 확인한다.
      //
      // 참고: fs.rename이 Windows에서는 기존 파일에 EPERM/EEXIST를 던진다는 통념은
      // 실측으로 반증되었다. libuv가 MOVEFILE_REPLACE_EXISTING을 쓰기 때문에
      // Windows에서도 POSIX와 똑같이 조용히 덮어쓴다(가드 제거 뮤테이션 결과:
      // "promise resolved undefined instead of rejecting"). 즉 이 가드는 모든
      // 플랫폼에서 필수다.
      await expect(localFs.rename(oldPath, newPath)).rejects.toThrow(
        /Target already exists: occupied\.txt/
      )

      // Neither side may be touched: the victim keeps its content and the
      // source is still there (fs.rename silently clobbers on POSIX).
      expect(await fs.readFile(newPath, 'utf8')).toBe('existing content')
      expect(await fs.readFile(oldPath, 'utf8')).toBe('source content')
    })
  })

  describe('rename — directory escape', () => {
    it('refuses a target that points at a different directory', async () => {
      // covers: Test-86
      // 이 층은 렌더러 검증을 우회해 IPC를 직접 호출하는 경로를 막으려고 존재한다.
      // 그러므로 렌더러를 거치지 않고 메서드를 직접 호출해 검증한다.
      const otherDir = path.join(tmpDir, 'other')
      await fs.mkdir(otherDir)
      const oldPath = path.join(tmpDir, 'stay.txt')
      await fs.writeFile(oldPath, 'payload')
      const escapedPath = path.join(otherDir, 'stay.txt')

      // Test-63과 같은 이유로 메시지까지 단언한다: 맨 toThrow()는 아무 OS 거부에나
      // 만족하므로, 거부의 출처가 이 가드임을 강제해야 한다.
      await expect(localFs.rename(oldPath, escapedPath)).rejects.toThrow(
        /Rename must stay in the same directory/
      )

      // 파일은 조용히 옮겨지지 않고 제자리에 남아야 한다.
      expect(await fs.readFile(oldPath, 'utf8')).toBe('payload')
      await expect(fs.access(escapedPath)).rejects.toThrow()

      // 대조군: 같은 디렉터리 안에서의 rename은 성공해야 한다. 가드를 "항상 거부"로
      // 바꾸는 뮤테이션은 위 단언들을 통과하므로 이 대비에서만 죽는다.
      const sameDirPath = path.join(tmpDir, 'renamed.txt')
      await localFs.rename(oldPath, sameDirPath)
      expect(await fs.readFile(sameDirPath, 'utf8')).toBe('payload')
    })
  })

  describe('mkdir', () => {
    it('creates a new directory', async () => {
      // covers: Test-64
      const dir = path.join(tmpDir, 'fresh')

      await localFs.mkdir(dir)

      expect((await fs.stat(dir)).isDirectory()).toBe(true)
    })

    it('fails when the name already exists', async () => {
      // covers: Test-65
      const dir = path.join(tmpDir, 'taken')
      await fs.mkdir(dir)
      await fs.writeFile(path.join(dir, 'marker.txt'), 'untouched')

      await expect(localFs.mkdir(dir)).rejects.toThrow()

      // recursive:true would have resolved silently and left this assertion
      // meaningless, so also prove the existing contents survived.
      expect(await fs.readFile(path.join(dir, 'marker.txt'), 'utf8')).toBe('untouched')
    })
  })
})
