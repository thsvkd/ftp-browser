import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FtpConnectionManager } from './FtpConnectionManager'
import { Client } from 'basic-ftp'
import type { FTPResponse, FileInfo } from 'basic-ftp'
import { EventEmitter } from 'events'

// Mock basic-ftp with prototype methods so `vi.mocked(Client.prototype.<fn>)` works
vi.mock('basic-ftp', () => {
  class MockClient {
    ftp: {
      verbose: boolean
      ipFamily: number
      socket: EventEmitter & {
        setTimeout: ReturnType<typeof vi.fn>
        destroy: ReturnType<typeof vi.fn>
      }
    }

    constructor() {
      this.ftp = {
        verbose: false,
        ipFamily: 4,
        socket: Object.assign(new EventEmitter(), {
          setTimeout: vi.fn(),
          destroy: vi.fn()
        })
      }
    }
  }

  // Assign mocks to the prototype so every instance shares the same fn
  MockClient.prototype['access' as keyof MockClient] = vi.fn() as never
  MockClient.prototype['list' as keyof MockClient] = vi.fn() as never
  MockClient.prototype['close' as keyof MockClient] = vi.fn() as never
  MockClient.prototype['trackProgress' as keyof MockClient] = vi.fn() as never

  return {
    Client: MockClient,
    FileInfo: class FileInfo {}
  }
})

vi.mock('../utils/errorClassifier', () => ({
  classifyError: vi.fn((err: unknown) => ({
    code: 'UNKNOWN',
    message: err instanceof Error ? err.message : String(err)
  }))
}))

vi.mock('@shared/constants', () => ({
  isImageFile: vi.fn((name: string) => {
    const ext = name.substring(name.lastIndexOf('.')).toLowerCase()
    return ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif'].includes(ext)
  })
}))

describe('FtpConnectionManager', () => {
  let manager: FtpConnectionManager

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(Client.prototype.access).mockReset()
    vi.mocked(Client.prototype.close).mockReset()
    vi.mocked(Client.prototype.list).mockReset()
    manager = new FtpConnectionManager()
  })

  describe('connect', () => {
    it('should connect successfully and set connected state', async () => {
      vi.mocked(Client.prototype.access).mockResolvedValue({} as unknown as FTPResponse)

      const result = await manager.connect({
        host: 'ftp.example.com',
        port: 21,
        user: 'testuser',
        password: 'testpass',
        secure: false
      })

      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()
      expect(manager.isConnected()).toBe(true)
      expect(manager.getHost()).toBe('ftp.example.com')
      expect(manager.getPort()).toBe(21)
    })

    it('should return error on connection failure', async () => {
      vi.mocked(Client.prototype.access).mockRejectedValue(new Error('Connection refused'))

      const result = await manager.connect({
        host: 'bad.host',
        port: 21,
        user: 'user',
        password: 'pass',
        secure: false
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Connection refused')
      expect(manager.isConnected()).toBe(false)
    })

    it('should emit connectionStatus events', async () => {
      vi.mocked(Client.prototype.access).mockResolvedValue({} as unknown as FTPResponse)

      const statusEvents: string[] = []
      manager.on('connectionStatus', (state) => statusEvents.push(state.status))

      await manager.connect({
        host: 'ftp.example.com',
        port: 21,
        user: 'user',
        password: 'pass',
        secure: false
      })

      expect(statusEvents).toContain('connecting')
      expect(statusEvents).toContain('connected')
    })

    it('should emit error status on failure', async () => {
      vi.mocked(Client.prototype.access).mockRejectedValue(new Error('Auth failed'))

      const statusEvents: Array<{ status: string; error?: string }> = []
      manager.on('connectionStatus', (state) => statusEvents.push(state))

      await manager.connect({
        host: 'ftp.example.com',
        port: 21,
        user: 'user',
        password: 'wrong',
        secure: false
      })

      const errorEvent = statusEvents.find((e) => e.status === 'error')
      expect(errorEvent).toBeDefined()
      expect(errorEvent?.error).toBe('Auth failed')
    })
  })

  describe('disconnect during connect', () => {
    it('should abort an in-flight connect and not emit connected or error', async () => {
      let rejectAccess: ((err: Error) => void) | undefined
      vi.mocked(Client.prototype.access).mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectAccess = reject
          })
      )
      vi.mocked(Client.prototype.close).mockImplementation(() => {
        rejectAccess?.(new Error('User closed client during task'))
      })

      const statuses: string[] = []
      manager.on('connectionStatus', (state) => statuses.push(state.status))

      const connectPromise = manager.connect({
        host: 'ftp.example.com',
        port: 21,
        user: 'user',
        password: 'pass',
        secure: false
      })
      await vi.waitFor(() => expect(Client.prototype.access).toHaveBeenCalled())

      await manager.disconnect()
      const result = await connectPromise

      expect(result.success).toBe(false)
      expect(result.cancelled).toBe(true)
      expect(manager.isConnected()).toBe(false)
      expect(statuses).toEqual(['connecting', 'disconnected'])
    })

    it('should not close a newer connect client when a stale access resolves', async () => {
      const accessResolvers: Array<(value: FTPResponse) => void> = []
      vi.mocked(Client.prototype.access).mockImplementation(
        () =>
          new Promise((resolve) => {
            accessResolvers.push(resolve)
          })
      )
      const closedClients: Client[] = []
      vi.mocked(Client.prototype.close).mockImplementation(function (this: Client) {
        closedClients.push(this)
      })

      const first = manager.connect({
        host: 'a.example',
        port: 21,
        user: 'user',
        password: 'pass',
        secure: false
      })
      await vi.waitFor(() => expect(accessResolvers).toHaveLength(1))

      await manager.disconnect()

      const second = manager.connect({
        host: 'b.example',
        port: 21,
        user: 'user',
        password: 'pass',
        secure: false
      })
      await vi.waitFor(() => expect(accessResolvers).toHaveLength(2))
      const newerClient = manager.getClient()

      accessResolvers[0]!({} as FTPResponse)
      await expect(first).resolves.toMatchObject({ success: false, cancelled: true })
      expect(closedClients).not.toContain(newerClient)

      accessResolvers[1]!({} as FTPResponse)
      await expect(second).resolves.toMatchObject({ success: true })
      expect(manager.isConnected()).toBe(true)
      expect(manager.getHost()).toBe('b.example')
    })

    it('should not mark connected if access finishes after disconnect', async () => {
      let resolveAccess: ((value: FTPResponse) => void) | undefined
      vi.mocked(Client.prototype.access).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveAccess = resolve
          })
      )

      const statuses: string[] = []
      manager.on('connectionStatus', (state) => statuses.push(state.status))

      const connectPromise = manager.connect({
        host: 'ftp.example.com',
        port: 21,
        user: 'user',
        password: 'pass',
        secure: false
      })
      await vi.waitFor(() => expect(Client.prototype.access).toHaveBeenCalled())

      await manager.disconnect()
      resolveAccess!({} as FTPResponse)
      const result = await connectPromise

      expect(result.success).toBe(false)
      expect(result.cancelled).toBe(true)
      expect(manager.isConnected()).toBe(false)
      expect(statuses).not.toContain('connected')
      expect(statuses).not.toContain('error')
    })
  })

  describe('disconnect', () => {
    it('should disconnect and set connected to false', async () => {
      vi.mocked(Client.prototype.access).mockResolvedValue({} as unknown as FTPResponse)
      await manager.connect({
        host: 'ftp.example.com',
        port: 21,
        user: 'user',
        password: 'pass',
        secure: false
      })

      await manager.disconnect()

      expect(manager.isConnected()).toBe(false)
      expect(Client.prototype.close).toHaveBeenCalled()
    })

    it('should emit disconnected status', async () => {
      vi.mocked(Client.prototype.access).mockResolvedValue({} as unknown as FTPResponse)
      await manager.connect({
        host: 'ftp.example.com',
        port: 21,
        user: 'user',
        password: 'pass',
        secure: false
      })

      const listener = vi.fn()
      manager.on('connectionStatus', listener)

      await manager.disconnect()

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 'disconnected' }))
    })
  })

  describe('list', () => {
    beforeEach(async () => {
      // list는 runOnMainClient를 거치므로 connected 상태가 전제.
      vi.mocked(Client.prototype.access).mockResolvedValue({} as unknown as FTPResponse)
      await manager.connect({
        host: 'host',
        port: 21,
        user: 'u',
        password: 'p',
        secure: false
      })
    })

    it('should return formatted file entries', async () => {
      vi.mocked(Client.prototype.list).mockResolvedValue([
        {
          name: 'photo.jpg',
          isDirectory: false,
          isSymbolicLink: false,
          size: 1024,
          modifiedAt: new Date('2024-01-01'),
          rawModifiedAt: 'Jan 01 2024',
          permissions: { user: 7, group: 5, world: 5 }
        },
        {
          name: 'subdir',
          isDirectory: true,
          isSymbolicLink: false,
          size: 4096,
          modifiedAt: new Date('2024-06-15'),
          rawModifiedAt: 'Jun 15 2024',
          permissions: { user: 7, group: 5, world: 5 }
        }
      ] as unknown as FileInfo[])

      const result = await manager.list('/test')

      expect(result.path).toBe('/test')
      expect(result.entries).toHaveLength(2)
      expect(result.entries[0].name).toBe('photo.jpg')
      expect(result.entries[0].type).toBe('file')
      expect(result.entries[0].isImage).toBe(true)
      expect(result.entries[0].size).toBe(1024)
      expect(result.entries[1].name).toBe('subdir')
      expect(result.entries[1].type).toBe('directory')
      expect(result.entries[1].isImage).toBe(false)
    })

    it('should handle symbolic links', async () => {
      vi.mocked(Client.prototype.list).mockResolvedValue([
        {
          name: 'link',
          isDirectory: false,
          isSymbolicLink: true,
          size: 0,
          modifiedAt: null,
          rawModifiedAt: '',
          permissions: null
        }
      ] as unknown as FileInfo[])

      const result = await manager.list('/test')

      expect(result.entries[0].type).toBe('symbolic-link')
    })

    it('should handle missing modifiedAt', async () => {
      vi.mocked(Client.prototype.list).mockResolvedValue([
        {
          name: 'file.txt',
          isDirectory: false,
          isSymbolicLink: false,
          size: 100,
          modifiedAt: null,
          rawModifiedAt: null,
          permissions: null
        }
      ] as unknown as FileInfo[])

      const result = await manager.list('/test')

      expect(result.entries[0].modifiedAt).toBe('')
      expect(result.entries[0].rawModifiedAt).toBe('')
      expect(result.entries[0].permissions).toBeUndefined()
    })
  })

  describe('createSecondaryClient', () => {
    it('should throw if not connected', async () => {
      await expect(manager.createSecondaryClient()).rejects.toThrow('Not connected')
    })
  })

  describe('getClient', () => {
    it('should return the internal client', () => {
      const client = manager.getClient()
      expect(client).toBeDefined()
    })
  })

  describe('runOnMainClient', () => {
    beforeEach(async () => {
      // mutex 검증은 connected 상태를 전제로 한다.
      vi.mocked(Client.prototype.access).mockResolvedValue({} as unknown as FTPResponse)
      await manager.connect({
        host: 'host',
        port: 21,
        user: 'u',
        password: 'p',
        secure: false
      })
    })

    it('should reject when not connected', async () => {
      await manager.disconnect()
      await expect(manager.runOnMainClient(async () => 1)).rejects.toThrow('Not connected')
    })

    it('should serialize concurrent tasks on the main client', async () => {
      // basic-ftp Client는 동시 task를 허용하지 않으므로 mutex가 직렬 실행을 보장해야 한다.
      const order: string[] = []
      let inFlight = 0
      let maxInFlight = 0

      const task = (label: string, ms: number) => async (): Promise<string> => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        order.push(`${label}:start`)
        await new Promise((r) => setTimeout(r, ms))
        order.push(`${label}:end`)
        inFlight--
        return label
      }

      const results = await Promise.all([
        manager.runOnMainClient(task('A', 30)),
        manager.runOnMainClient(task('B', 10)),
        manager.runOnMainClient(task('C', 5))
      ])

      expect(results).toEqual(['A', 'B', 'C'])
      expect(maxInFlight).toBe(1)
      expect(order).toEqual(['A:start', 'A:end', 'B:start', 'B:end', 'C:start', 'C:end'])
    })

    it('should let subsequent tasks run even after a previous task rejects', async () => {
      const failing = manager.runOnMainClient(async () => {
        throw new Error('boom')
      })
      await expect(failing).rejects.toThrow('boom')

      // 다음 task는 이전 실패에 영향을 받지 않고 정상 실행되어야 한다.
      const ok = await manager.runOnMainClient(async () => 42)
      expect(ok).toBe(42)
    })

    it('should pass the current internal client to the task', async () => {
      const internal = manager.getClient()
      const received = await manager.runOnMainClient(async (c) => c)
      expect(received).toBe(internal)
    })
  })
})
