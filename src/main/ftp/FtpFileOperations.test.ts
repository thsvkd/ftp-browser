import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FtpFileOperations } from './FtpFileOperations'
import type { FtpConnectionManager } from './FtpConnectionManager'

interface MockClient {
  uploadFrom: ReturnType<typeof vi.fn>
  downloadTo: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  removeDir: ReturnType<typeof vi.fn>
  rename: ReturnType<typeof vi.fn>
  ensureDir: ReturnType<typeof vi.fn>
  cd: ReturnType<typeof vi.fn>
  trackProgress: ReturnType<typeof vi.fn>
}

function createMockManager(): { manager: FtpConnectionManager; client: MockClient } {
  const mockClient: MockClient = {
    uploadFrom: vi.fn().mockResolvedValue(undefined),
    downloadTo: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    removeDir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    cd: vi.fn().mockResolvedValue(undefined),
    trackProgress: vi.fn()
  }

  return {
    manager: {
      getClient: vi.fn(() => mockClient)
    } as unknown as FtpConnectionManager,
    client: mockClient
  }
}

describe('FtpFileOperations', () => {
  let ops: FtpFileOperations
  let mockClient: ReturnType<typeof createMockManager>['client']

  beforeEach(() => {
    vi.clearAllMocks()
    const mock = createMockManager()
    mockClient = mock.client
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
    it('should call ensureDir and cd back to parent', async () => {
      await ops.mkdir('/remote/parent/newdir')

      expect(mockClient.ensureDir).toHaveBeenCalledWith('/remote/parent/newdir')
      expect(mockClient.cd).toHaveBeenCalledWith('/remote/parent')
    })

    it('should cd to root if path has no parent separator', async () => {
      await ops.mkdir('/newdir')

      expect(mockClient.ensureDir).toHaveBeenCalledWith('/newdir')
      expect(mockClient.cd).toHaveBeenCalledWith('/')
    })
  })
})
