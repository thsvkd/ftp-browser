import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { Writable } from 'stream'
import { FtpFileOperations } from './FtpFileOperations'
import { fastUpload, DOWNLOAD_WRITE_BUFFER } from './fastTransfer'
import { SegmentWriter } from './segmentWriter'
import type { Client } from 'basic-ftp'
import type { FtpConnectionManager, FtpMutationEvent } from './FtpConnectionManager'

// 업로드는 fastUpload를 흉내 낸다. 실제 읽기 동작은 fastTransfer.test.ts가 목 서버로 확인한다.
vi.mock('./fastTransfer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fastTransfer')>()),
  fastUpload: vi.fn().mockResolvedValue(undefined)
}))

interface MockClient {
  /** 평문 제어 연결. downloadInto가 데이터 소켓 생성 함수를 바꿔 끼운다. */
  ftp: { socket: object; _newSocket: () => net.Socket }
  uploadFrom: ReturnType<typeof vi.fn>
  downloadTo: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  removeEmptyDir: ReturnType<typeof vi.fn>
  rename: ReturnType<typeof vi.fn>
  sendIgnoringError: ReturnType<typeof vi.fn>
  trackProgress: ReturnType<typeof vi.fn>
}

function plainContext(): MockClient['ftp'] {
  return { socket: {}, _newSocket: () => new net.Socket() }
}

function createMockManager(): {
  manager: FtpConnectionManager
  client: MockClient
  emit: ReturnType<typeof vi.fn>
  runOnMainClient: ReturnType<typeof vi.fn>
} {
  const mockClient: MockClient = {
    ftp: plainContext(),
    uploadFrom: vi.fn().mockResolvedValue(undefined),
    downloadTo: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    removeEmptyDir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    sendIgnoringError: vi.fn().mockResolvedValue({ code: 257, message: '257 OK' }),
    trackProgress: vi.fn()
  }

  const emit = vi.fn()
  const runOnMainClient = vi.fn(<T>(task: (c: MockClient) => Promise<T>) => task(mockClient))
  return {
    manager: {
      getClient: vi.fn(() => mockClient),
      runOnMainClient,
      emit
    } as unknown as FtpConnectionManager,
    client: mockClient,
    emit,
    runOnMainClient
  }
}

describe('FtpFileOperations', () => {
  let ops: FtpFileOperations
  let mockClient: ReturnType<typeof createMockManager>['client']
  let emit: ReturnType<typeof createMockManager>['emit']
  let runOnMainClient: ReturnType<typeof createMockManager>['runOnMainClient']

  /** 다운로드는 로컬 파일을 직접 열므로 실제 임시 폴더에 받는다 */
  let tmp: string

  beforeEach(() => {
    vi.clearAllMocks()
    const mock = createMockManager()
    mockClient = mock.client
    emit = mock.emit
    runOnMainClient = mock.runOnMainClient
    ops = new FtpFileOperations(mock.manager)
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fileops-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  describe('upload', () => {
    it('should upload through fastUpload on the main client with the fast flow off', async () => {
      await ops.upload('/local/file.jpg', '/remote/file.jpg')
      expect(fastUpload).toHaveBeenCalledWith(
        mockClient,
        '/local/file.jpg',
        '/remote/file.jpg',
        false
      )
    })

    it('should set up progress tracking when callback is provided', async () => {
      const onProgress = vi.fn()
      await ops.upload('/local/file.jpg', '/remote/file.jpg', onProgress)

      expect(mockClient.trackProgress).toHaveBeenCalledTimes(2) // setup + cleanup
      expect(mockClient.trackProgress).toHaveBeenNthCalledWith(1, expect.any(Function))
      expect(mockClient.trackProgress).toHaveBeenNthCalledWith(2) // cleanup with no args
    })

    it('should clean up progress tracking even on error', async () => {
      vi.mocked(fastUpload).mockRejectedValueOnce(new Error('Upload failed'))

      await expect(ops.upload('/local/file.jpg', '/remote/file.jpg', vi.fn())).rejects.toThrow(
        'Upload failed'
      )

      // trackProgress() called with no args to clean up
      expect(mockClient.trackProgress).toHaveBeenLastCalledWith()
    })
  })

  describe('download', () => {
    /** downloadTo가 받은 Writable에 data를 쓰고 끝내는 흉내(basic-ftp는 finish 뒤에 resolve한다) */
    function serve(client: MockClient, data: Buffer): Writable[] {
      const targets: Writable[] = []
      client.downloadTo.mockImplementation(async (target: Writable) => {
        targets.push(target)
        await new Promise<void>((resolve, reject) => {
          target.on('error', reject)
          target.end(data, () => resolve())
        })
      })
      return targets
    }

    it('should download from offset 0 into a SegmentWriter over the whole local file', async () => {
      const localPath = path.join(tmp, 'file.jpg')
      const data = Buffer.alloc(5000, 9)
      const targets = serve(mockClient, data)

      await ops.download('/remote/file.jpg', localPath)

      expect(mockClient.downloadTo).toHaveBeenCalledWith(
        expect.any(SegmentWriter),
        '/remote/file.jpg',
        0
      )
      // FTPS는 스트림 경로라 TLS 레코드(16 KiB)를 이 버퍼까지 모아 한 번에 쓴다
      expect(targets[0].writableHighWaterMark).toBe(DOWNLOAD_WRITE_BUFFER)
      expect(DOWNLOAD_WRITE_BUFFER).toBe(4 * 1024 * 1024)
      expect(fs.readFileSync(localPath).equals(data)).toBe(true)
    })

    it('should remove an empty local file when the download fails before any data', async () => {
      const localPath = path.join(tmp, 'file.jpg')
      mockClient.downloadTo.mockRejectedValueOnce(new Error('550 No such file'))

      await expect(ops.download('/remote/file.jpg', localPath)).rejects.toThrow('550')
      expect(fs.existsSync(localPath)).toBe(false)
    })

    it('should keep a partly downloaded local file when the download fails midway', async () => {
      const localPath = path.join(tmp, 'file.jpg')
      mockClient.downloadTo.mockImplementationOnce(async (target: Writable) => {
        await new Promise<void>((resolve) => target.write(Buffer.alloc(100, 1), () => resolve()))
        throw new Error('reset')
      })

      await expect(ops.download('/remote/file.jpg', localPath)).rejects.toThrow('reset')
      expect(fs.statSync(localPath).size).toBe(100)
    })

    /** 첫 조각은 바로 쓰기에 들어가고 나머지는 버퍼에 쌓이도록 기다리지 않고 여러 조각을 쓴다 */
    function writeUnawaited(target: Writable): Buffer[] {
      const parts = [0, 1, 2, 3].map((i) => Buffer.alloc(256 * 1024, i + 1))
      for (const part of parts) target.write(part)
      return parts
    }

    it('should let the in-flight write land and drop the rest before a failed download settles', async () => {
      const localPath = path.join(tmp, 'file.jpg')
      let parts: Buffer[] = []
      mockClient.downloadTo.mockImplementationOnce(async (target: Writable) => {
        parts = writeUnawaited(target)
        throw new Error('reset')
      })

      await expect(ops.download('/remote/file.jpg', localPath)).rejects.toThrow('reset')

      // 파일을 닫기 전에 진행 중이던 쓰기가 끝났고, 그 뒤의 조각은 쓰지 않았다
      expect(fs.readFileSync(localPath).equals(parts[0])).toBe(true)
    })

    it('should settle when the transfer destroys the writer with an error', async () => {
      const localPath = path.join(tmp, 'file.jpg')
      mockClient.downloadTo.mockImplementationOnce(async (target: Writable) => {
        // stream.pipeline은 데이터 소켓이 실패하면 대상 스트림을 에러로 destroy한다
        writeUnawaited(target)
        target.destroy(new Error('socket reset'))
        throw new Error('socket reset')
      })

      await expect(ops.download('/remote/file.jpg', localPath)).rejects.toThrow('socket reset')
    })

    it('should clean up progress tracking on error', async () => {
      mockClient.downloadTo.mockRejectedValueOnce(new Error('Download failed'))

      await expect(
        ops.download('/remote/file.jpg', path.join(tmp, 'file.jpg'), vi.fn())
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

  describe('explicit client parameter', () => {
    function createOwnClient(): MockClient {
      return {
        ftp: plainContext(),
        uploadFrom: vi.fn().mockResolvedValue(undefined),
        downloadTo: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn(),
        list: vi.fn(),
        removeEmptyDir: vi.fn(),
        rename: vi.fn(),
        sendIgnoringError: vi.fn(),
        trackProgress: vi.fn()
      }
    }
    // 전용 클라이언트는 mock manager의 클라이언트와 달라야 "메인 클라이언트를 안 쓴다"를 증명할 수 있다.
    function asClient(c: MockClient): Client {
      return c as unknown as Client
    }

    it('uploads on the given client without touching the main client', async () => {
      const own = createOwnClient()
      await ops.upload('/local/a.txt', '/remote/a.txt', undefined, asClient(own))

      expect(fastUpload).toHaveBeenCalledTimes(1)
      expect(fastUpload).toHaveBeenCalledWith(own, '/local/a.txt', '/remote/a.txt', false)
      expect(runOnMainClient).not.toHaveBeenCalled()
    })

    it('uploads through the fast flow on the given client when asked', async () => {
      const own = createOwnClient()
      const onProgress = vi.fn()
      await ops.upload('/local/a.txt', '/remote/a.txt', onProgress, asClient(own), true)

      expect(fastUpload).toHaveBeenCalledWith(own, '/local/a.txt', '/remote/a.txt', true)
      expect(own.trackProgress).toHaveBeenNthCalledWith(1, expect.any(Function))
      expect(own.trackProgress).toHaveBeenLastCalledWith()
    })

    it('keeps the standard path on the main client even when the fast flow is asked', async () => {
      await ops.upload('/local/a.txt', '/remote/a.txt', undefined, undefined, true)

      expect(fastUpload).toHaveBeenCalledWith(mockClient, '/local/a.txt', '/remote/a.txt', false)
    })

    it('downloads on the given client without touching the main client', async () => {
      const own = createOwnClient()
      await ops.download('/remote/a.txt', path.join(tmp, 'a.txt'), undefined, asClient(own))

      expect(own.downloadTo.mock.calls[0]).toEqual([expect.any(Writable), '/remote/a.txt', 0])
      expect(mockClient.downloadTo).not.toHaveBeenCalled()
      expect(runOnMainClient).not.toHaveBeenCalled()
    })

    it('sets progress tracking and clears it afterwards', async () => {
      const own = createOwnClient()
      const onProgress = vi.fn()
      vi.mocked(fastUpload).mockImplementationOnce(async () => {
        own.trackProgress.mock.calls[0][0]({ bytes: 5, bytesOverall: 9 })
        return { code: 226, message: '226 OK' }
      })
      await ops.upload('/local/a.txt', '/remote/a.txt', onProgress, asClient(own))

      expect(onProgress).toHaveBeenCalledWith({ bytes: 5, bytesOverall: 9 })
      expect(own.trackProgress).toHaveBeenLastCalledWith()
    })

    it('clears progress tracking when the transfer fails', async () => {
      const own = createOwnClient()
      own.downloadTo.mockRejectedValueOnce(new Error('boom'))
      await expect(
        ops.download('/remote/a.txt', path.join(tmp, 'a.txt'), vi.fn(), asClient(own))
      ).rejects.toThrow('boom')
      expect(own.trackProgress).toHaveBeenLastCalledWith()
    })

    it('still emits the upload mutation, but not one for download', async () => {
      const own = createOwnClient()
      await ops.download('/remote/a.txt', path.join(tmp, 'a.txt'), undefined, asClient(own))
      expect(emit.mock.calls.filter((c) => c[0] === 'mutation')).toHaveLength(0)

      await ops.upload('/local/a.txt', '/remote/a.txt', undefined, asClient(own))
      expect(emit).toHaveBeenCalledWith('mutation', { kind: 'upload', remotePath: '/remote/a.txt' })
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
      vi.mocked(fastUpload).mockRejectedValueOnce(new Error('boom'))
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
      await ops.download('/remote/a.txt', path.join(tmp, 'a.txt'))
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
