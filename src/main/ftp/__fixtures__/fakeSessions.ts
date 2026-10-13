/**
 * 연결 레지스트리·허브·IPC 테스트의 가짜 세션. 매니저와 파일 작업은 `FakeRemote`(메모리 원격 트리)이고,
 * FtpConnectionManager처럼 연결·해제 때 `connectionStatus`를 낸다. 테스트가 아닌 모듈이다.
 */
import { vi } from 'vitest'
import { parseConnKey, type ConnKey } from '@shared/connKey'
import type { ConnectionStatus, FtpConnectPayload } from '@shared/types/ftp'
import { FakeRemote, FakeQueue } from '../../mcp/__fixtures__/agentHarness'
import { LIMIT, type TransferClientPool } from '../../transfer/TransferClientPool'
import type { TransferQueue } from '../../transfer/TransferQueue'
import type { FtpSession } from '../ConnectionRegistry'
import type { FtpConnectionManager } from '../FtpConnectionManager'
import type { FtpFileOperations } from '../FtpFileOperations'
import type { ThumbnailQueue } from '../../thumbnail/ThumbnailQueue'
import type { RemoteGalleryPreviewQueue } from '../RemoteGalleryPreviewQueue'

/** 연결 하나. 처음에는 끊겨 있고, 키의 host·port·user를 갖는다. */
export class FakeConnection extends FakeRemote {
  constructor(key: ConnKey) {
    super()
    const { host, port, user } = parseConnKey(key)!
    this.host = host
    this.port = port
    this.user = user
    this.connected = false
    this.status = 'disconnected'
    this.connect.mockImplementation(async (config: FtpConnectPayload) => {
      this.setStatus('connecting', config.host)
      if (!this.connectResult.success) {
        this.setStatus('error', config.host, this.connectResult.error)
        return this.connectResult
      }
      this.connected = true
      this.setStatus('connected', config.host)
      return this.connectResult
    })
    this.disconnect.mockImplementation(async () => {
      this.connected = false
      this.setStatus('disconnected')
    })
  }

  /** FtpConnectionManager.emitStatus와 같은 모양으로 알린다 */
  setStatus(status: ConnectionStatus, host?: string, error?: string): void {
    this.status = status
    this.emit('connectionStatus', { status, host, error })
  }
}

/** 세션의 매니저(가짜 연결) */
export function remoteOf(session: FtpSession | undefined): FakeConnection {
  return session!.manager as unknown as FakeConnection
}

/** 키로 로그인하는 연결 요청 */
export function payloadOf(key: ConnKey): FtpConnectPayload {
  const { host, port, user } = parseConnKey(key)!
  return { host, port, user, password: 'pw', secure: false }
}

/**
 * 가짜 세션. 매니저·파일 작업은 같은 `FakeConnection`, 큐는 `FakeQueue`(테스트가 진짜 큐로 바꿀 수 있다).
 * 썸네일·폴더 미리보기 큐는 쓰는 테스트가 넣는다.
 */
export function fakeSession(
  key: ConnKey,
  parts: Partial<Omit<FtpSession, 'key' | 'manager' | 'fileOps'>> = {}
): FtpSession {
  const remote = new FakeConnection(key)
  return {
    key,
    manager: remote as unknown as FtpConnectionManager,
    fileOps: remote as unknown as FtpFileOperations,
    pool: {} as TransferClientPool,
    queue: new FakeQueue() as unknown as TransferQueue,
    thumbs: {} as ThumbnailQueue,
    gallery: {} as RemoteGalleryPreviewQueue,
    ...parts
  }
}

/** 큐 테스트용 풀: 한도만큼 새 가짜 클라이언트를 주고, 넘으면 LIMIT. */
export function fakePool(limit: number): TransferClientPool {
  let open = 0
  const client = (): { closed: boolean; close: () => void } => {
    const c = {
      closed: false,
      close: vi.fn(() => {
        c.closed = true
      })
    }
    return c
  }
  const give = (): void => {
    open--
  }
  return {
    limit,
    slots: limit,
    segmentedBroken: false,
    fastBroken: false,
    acquire: vi.fn(async () => {
      if (open >= limit) return LIMIT
      open++
      return client()
    }),
    release: vi.fn(give),
    discard: vi.fn(give),
    releaseAfterError: vi.fn(give),
    armIdleClose: vi.fn(),
    takeFreshLogin: vi.fn(() => true),
    probeDelay: vi.fn(() => Infinity),
    runOnMainClient: vi.fn()
  } as unknown as TransferClientPool
}
