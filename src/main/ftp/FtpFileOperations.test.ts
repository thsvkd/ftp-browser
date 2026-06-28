import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FtpFileOperations } from './FtpFileOperations'
import type { FtpConnectionManager, FtpMutationEvent } from './FtpConnectionManager'

interface MockClient {
  uploadFrom: ReturnType<typeof vi.fn>
  downloadTo: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  removeDir: ReturnType<typeof vi.fn>
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
    downloadTo: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    removeDir: vi.fn().mockResolvedValue(undefined),
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

  beforeEach(() => {
    vi.clearAllMocks()
    const mock = createMockManager()
    mockClient = mock.client
    emit = mock.emit
    ops = new FtpFileOperations(mock.manager)
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
    it('should call downloadTo on the client', async () => {
      await ops.download('/remote/file.jpg', '/local/file.jpg')
      expect(mockClient.downloadTo).toHaveBeenCalledWith('/local/file.jpg', '/remote/file.jpg')
    })

    it('should clean up progress tracking on error', async () => {
      mockClient.downloadTo.mockRejectedValueOnce(new Error('Download failed'))

      await expect(ops.download('/remote/file.jpg', '/local/file.jpg', vi.fn())).rejects.toThrow(
        'Download failed'
      )

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
    it('should call removeDir on the client', async () => {
      await ops.deleteDirectory('/remote/dir')
      expect(mockClient.removeDir).toHaveBeenCalledWith('/remote/dir')
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

      expect(mockClient.sendIgnoringError).toHaveBeenLastCalledWith('MKD /device/DCIM/3GS (@3GSSSS)')
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

    it('does NOT emit a mutation when deleteDirectory fails', async () => {
      mockClient.removeDir.mockRejectedValueOnce(new Error('perm denied'))
      await expect(ops.deleteDirectory('/remote/dir')).rejects.toThrow('perm denied')
      expect(lastMutation()).toBeUndefined()
    })

    it('does NOT emit a mutation when rename fails', async () => {
      mockClient.rename.mockRejectedValueOnce(new Error('not found'))
      await expect(ops.rename('/old', '/new')).rejects.toThrow('not found')
      expect(lastMutation()).toBeUndefined()
    })

    it('does NOT emit a mutation for download (read-only)', async () => {
      await ops.download('/remote/a.txt', '/local/a.txt')
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
