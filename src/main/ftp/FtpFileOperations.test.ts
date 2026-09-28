import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { FtpFileOperations } from './FtpFileOperations'
import type { FtpConnectionManager, FtpMutationEvent } from './FtpConnectionManager'

interface MockClient {
  uploadFrom: ReturnType<typeof vi.fn>
  downloadTo: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  removeEmptyDir: ReturnType<typeof vi.fn>
  rename: ReturnType<typeof vi.fn>
  sendIgnoringError: ReturnType<typeof vi.fn>
  trackProgress: ReturnType<typeof vi.fn>
}

function createMockManager(): {
  manager: FtpConnectionManager
  client: MockClient
  emit: ReturnType<typeof vi.fn>
} {
  const mockClient: MockClient = {
    uploadFrom: vi.fn().mockResolvedValue(undefined),
    // Like basic-ftp, write the remote bytes to whatever local path it is given.
    downloadTo: vi.fn(async (localPath: string) => fs.writeFile(localPath, 'remote data')),
    remove: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    removeEmptyDir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    sendIgnoringError: vi.fn().mockResolvedValue({ code: 257, message: '257 OK' }),
    trackProgress: vi.fn()
  }

  const emit = vi.fn()
  return {
    manager: {
      getClient: vi.fn(() => mockClient),
      runOnMainClient: vi.fn(<T>(task: (c: MockClient) => Promise<T>) => task(mockClient)),
      emit
    } as unknown as FtpConnectionManager,
    client: mockClient,
    emit
  }
}

describe('FtpFileOperations', () => {
  let ops: FtpFileOperations
  let mockClient: ReturnType<typeof createMockManager>['client']
  let emit: ReturnType<typeof createMockManager>['emit']
  let tmpDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-ops-test-'))
    const mock = createMockManager()
    mockClient = mock.client
    emit = mock.emit
    ops = new FtpFileOperations(mock.manager)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('upload', () => {
    it('should call uploadFrom on the client', async () => {
      await ops.upload('/local/file.jpg', '/remote/file.jpg')
      expect(mockClient.uploadFrom).toHaveBeenCalledWith('/local/file.jpg', '/remote/file.jpg')
    })

    it('should set up progress tracking when callback is provided', async () => {
      const onProgress = vi.fn()
      await ops.upload('/local/file.jpg', '/remote/file.jpg', onProgress)

      expect(mockClient.trackProgress).toHaveBeenCalledTimes(2) // setup + cleanup
      expect(mockClient.trackProgress).toHaveBeenNthCalledWith(1, expect.any(Function))
      expect(mockClient.trackProgress).toHaveBeenNthCalledWith(2) // cleanup with no args
    })

    it('should clean up progress tracking even on error', async () => {
      mockClient.uploadFrom.mockRejectedValueOnce(new Error('Upload failed'))

      await expect(ops.upload('/local/file.jpg', '/remote/file.jpg', vi.fn())).rejects.toThrow(
        'Upload failed'
      )

      // trackProgress() called with no args to clean up
      expect(mockClient.trackProgress).toHaveBeenLastCalledWith()
    })
  })

  describe('download', () => {
    it('writes the remote file to the local path', async () => {
      const localPath = path.join(tmpDir, 'file.jpg')

      await ops.download('/remote/file.jpg', localPath)

      expect(mockClient.downloadTo).toHaveBeenCalledWith(expect.any(String), '/remote/file.jpg')
      expect(await fs.readFile(localPath, 'utf8')).toBe('remote data')
      expect(await fs.readdir(tmpDir)).toEqual(['file.jpg'])
    })

    it('replaces an existing local file once the download completes', async () => {
      const localPath = path.join(tmpDir, 'file.jpg')
      await fs.writeFile(localPath, 'old')

      await ops.download('/remote/file.jpg', localPath)

      expect(await fs.readFile(localPath, 'utf8')).toBe('remote data')
    })

    it('keeps an existing local file and leaves no partial file when the download fails', async () => {
      const localPath = path.join(tmpDir, 'file.jpg')
      await fs.writeFile(localPath, 'precious')
      mockClient.downloadTo.mockImplementationOnce(async (partPath: string) => {
        await fs.writeFile(partPath, 'half')
        throw new Error('426 Connection closed; transfer aborted')
      })

      await expect(ops.download('/remote/file.jpg', localPath)).rejects.toThrow('426')

      expect(await fs.readFile(localPath, 'utf8')).toBe('precious')
      expect(await fs.readdir(tmpDir)).toEqual(['file.jpg'])
    })

    it('should clean up progress tracking on error', async () => {
      mockClient.downloadTo.mockRejectedValueOnce(new Error('Download failed'))

      await expect(
        ops.download('/remote/file.jpg', path.join(tmpDir, 'file.jpg'), vi.fn())
      ).rejects.toThrow('Download failed')

      expect(mockClient.trackProgress).toHaveBeenLastCalledWith()
    })
  })

  describe('deleteFile', () => {
    it('should call remove on the client', async () => {
      await ops.deleteFile('/remote/file.jpg')
      expect(mockClient.remove).toHaveBeenCalledWith('/remote/file.jpg')
    })
  })

  describe('deleteDirectory', () => {
    it('empties nested folders depth-first by absolute path, then removes the folder', async () => {
      const tree: Record<string, Array<{ name: string; isDirectory: boolean }>> = {
        '/remote/dir': [
          { name: '.', isDirectory: true },
          { name: '..', isDirectory: true },
          { name: 'a.jpg', isDirectory: false },
          { name: 'sub (1)', isDirectory: true }
        ],
        '/remote/dir/sub (1)': [
          { name: 'b.jpg', isDirectory: false },
          { name: 'deeper', isDirectory: true }
        ],
        '/remote/dir/sub (1)/deeper': []
      }
      const calls: string[] = []
      mockClient.list.mockImplementation(async (p: string) => tree[p])
      mockClient.remove.mockImplementation(async (p: string) => calls.push(`DELE ${p}`))
      mockClient.removeEmptyDir.mockImplementation(async (p: string) => calls.push(`RMD ${p}`))

      const progress: string[] = []
      await ops.deleteDirectory('/remote/dir', (removed, total, path) =>
        progress.push(`${removed}/${total} ${path}`)
      )

      // 트리를 먼저 다 LIST하므로 첫 삭제부터 total이 정확하다.
      expect(progress).toEqual([
        '1/5 /remote/dir/a.jpg',
        '2/5 /remote/dir/sub (1)/b.jpg',
        '3/5 /remote/dir/sub (1)/deeper',
        '4/5 /remote/dir/sub (1)',
        '5/5 /remote/dir'
      ])
      expect(calls).toEqual([
        'DELE /remote/dir/a.jpg',
        'DELE /remote/dir/sub (1)/b.jpg',
        'RMD /remote/dir/sub (1)/deeper',
        'RMD /remote/dir/sub (1)',
        'RMD /remote/dir'
      ])
    })
  })

  describe('rename', () => {
    it('should call rename on the client', async () => {
      await ops.rename('/remote/old.txt', '/remote/new.txt')
      expect(mockClient.rename).toHaveBeenCalledWith('/remote/old.txt', '/remote/new.txt')
    })
  })

  describe('mkdir', () => {
    it('issues an absolute MKD for each path level without any CWD', async () => {
      await ops.mkdir('/remote/parent/newdir')

      expect(mockClient.sendIgnoringError.mock.calls.map((c) => c[0])).toEqual([
        'MKD /remote',
        'MKD /remote/parent',
        'MKD /remote/parent/newdir'
      ])
    })

    it('handles a single top-level directory', async () => {
      await ops.mkdir('/newdir')

      expect(mockClient.sendIgnoringError.mock.calls.map((c) => c[0])).toEqual(['MKD /newdir'])
    })

    it('preserves spaces and special characters in directory names', async () => {
      await ops.mkdir('/device/DCIM/3GS (@3GSSSS)')

      expect(mockClient.sendIgnoringError).toHaveBeenLastCalledWith(
        'MKD /device/DCIM/3GS (@3GSSSS)'
      )
    })

    it('resolves when MKD reports the directory already exists (the original bug)', async () => {
      // sendIgnoringError accepts FTP negative replies, so an existing dir is the
      // idempotent success case — no throw, unlike basic-ftp ensureDir's CWD step.
      mockClient.sendIgnoringError.mockResolvedValue({ code: 550, message: '550 Already exists' })

      await expect(ops.mkdir('/remote/parent/newdir')).resolves.toBeUndefined()
      expect(mockClient.sendIgnoringError).toHaveBeenCalledTimes(3)
    })

    it('propagates a socket/timeout error and does NOT emit a mutation', async () => {
      mockClient.sendIgnoringError.mockRejectedValueOnce(new Error('ECONNRESET'))

      await expect(ops.mkdir('/remote/parent/newdir')).rejects.toThrow('ECONNRESET')

      const mutations = emit.mock.calls.filter((c) => c[0] === 'mutation')
      expect(mutations).toHaveLength(0)
    })
  })

  describe('mutation events', () => {
    function lastMutation(): FtpMutationEvent | undefined {
      const calls = emit.mock.calls.filter((c) => c[0] === 'mutation')
      return calls.length ? (calls[calls.length - 1][1] as FtpMutationEvent) : undefined
    }

    it('emits "upload" mutation after a successful upload', async () => {
      await ops.upload('/local/a.txt', '/remote/a.txt')
      expect(lastMutation()).toEqual({ kind: 'upload', remotePath: '/remote/a.txt' })
    })

    it('does NOT emit a mutation when upload fails', async () => {
      mockClient.uploadFrom.mockRejectedValueOnce(new Error('boom'))
      await expect(ops.upload('/local/a.txt', '/remote/a.txt')).rejects.toThrow('boom')
      expect(lastMutation()).toBeUndefined()
    })

    it('still emits a mutation when a recursive delete fails midway', async () => {
      // 하위 항목 일부는 이미 지워졌으므로 캐시를 무효화해야 한다.
      mockClient.removeEmptyDir.mockRejectedValueOnce(new Error('perm denied'))
      await expect(ops.deleteDirectory('/remote/dir')).rejects.toThrow('perm denied')
      expect(lastMutation()).toEqual({ kind: 'delete', remotePath: '/remote/dir' })
    })

    it('does NOT emit a mutation when rename fails', async () => {
      mockClient.rename.mockRejectedValueOnce(new Error('not found'))
      await expect(ops.rename('/old', '/new')).rejects.toThrow('not found')
      expect(lastMutation()).toBeUndefined()
    })

    it('does NOT emit a mutation for download (read-only)', async () => {
      await ops.download('/remote/a.txt', path.join(tmpDir, 'a.txt'))
      expect(lastMutation()).toBeUndefined()
    })

    it('emits "delete" mutation after deleteFile', async () => {
      await ops.deleteFile('/remote/a.txt')
      expect(lastMutation()).toEqual({ kind: 'delete', remotePath: '/remote/a.txt' })
    })

    it('emits "delete" mutation after deleteDirectory', async () => {
      await ops.deleteDirectory('/remote/dir')
      expect(lastMutation()).toEqual({ kind: 'delete', remotePath: '/remote/dir' })
    })

    it('emits "rename" mutation with both paths', async () => {
      await ops.rename('/remote/old.txt', '/remote/new.txt')
      expect(lastMutation()).toEqual({
        kind: 'rename',
        remotePath: '/remote/old.txt',
        newPath: '/remote/new.txt'
      })
    })

    it('emits "mkdir" mutation after mkdir', async () => {
      await ops.mkdir('/remote/parent/newdir')
      expect(lastMutation()).toEqual({ kind: 'mkdir', remotePath: '/remote/parent/newdir' })
    })
  })
})
