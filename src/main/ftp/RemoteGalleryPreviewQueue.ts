import { Client } from 'basic-ftp'
import { FtpConnectionManager } from './FtpConnectionManager'
import { RemoteFolderPreviewCache } from './RemoteFolderPreviewCache'
import { normalizeRemotePath } from '../utils/remotePath'
import { isImageFile } from '@shared/constants'
import type { RemoteFolderPreview } from '@shared/types/gallery'

const PREVIEW_TIMEOUT_MS = 15_000
const MAX_CONCURRENT = 2

interface PendingItem {
  host: string
  port: number
  remotePath: string
  resolve: (value: RemoteFolderPreview | null) => void
  reject: (err: Error) => void
}

/**
 * Remote gallery folder preview를 직렬화하는 큐.
 *
 * - 매 요청마다 secondary FTP client를 새로 만들지 않고 풀에서 재사용 → 동시 연결 폭발 방지
 * - maxConcurrent로 동시 처리 제한 → 서버 connection 한도 초과 방지
 * - 메인 client에는 절대 손대지 않음 → 사용자 navigation과 충돌 방지
 * - 결과는 SQLite(`folder_previews`)에 영구 캐시. 재방문 시 LIST 재발급 없이 즉시 응답.
 * - 동일 (host,port,path) 동시 요청은 in-flight promise를 공유 → 중복 LIST 방지
 */
export class RemoteGalleryPreviewQueue {
  private queue: PendingItem[] = []
  private active = 0
  private clientPool: Client[] = []
  private availableClients: Client[] = []
  private secondaryUnavailable = false
  private inFlight = new Map<string, Promise<RemoteFolderPreview | null>>()

  constructor(
    private ftpManager: FtpConnectionManager,
    private cache: RemoteFolderPreviewCache
  ) {}

  request(remotePath: string): Promise<RemoteFolderPreview | null> {
    const host = this.ftpManager.getHost()
    const port = this.ftpManager.getPort()
    const path = normalizeRemotePath(remotePath)

    // 캐시 hit이면 LIST 재발급 없이 즉시 반환. undefined만 캐시 미스이므로 큐로 진행.
    const cached = this.cache.lookup(host, port, path)
    if (cached !== undefined) {
      return Promise.resolve(cached)
    }

    // 동일 키의 진행 중 요청이 있으면 그 promise를 공유 (TOCTOU 방지, 중복 LIST 방지).
    const flightKey = `${host}|${port}|${path}`
    const existing = this.inFlight.get(flightKey)
    if (existing) return existing

    const promise = new Promise<RemoteFolderPreview | null>((resolve, reject) => {
      this.queue.push({ host, port, remotePath: path, resolve, reject })
      void this.processNext()
    }).finally(() => {
      this.inFlight.delete(flightKey)
    })

    this.inFlight.set(flightKey, promise)
    return promise
  }

  cancelAll(): void {
    const pending = this.queue
    this.queue = []
    for (const item of pending) {
      item.reject(new Error('Cancelled'))
    }
    for (const client of this.clientPool) {
      try {
        client.close()
      } catch {
        // ignore
      }
    }
    this.clientPool = []
    this.availableClients = []
    this.secondaryUnavailable = false
  }

  private async acquireClient(): Promise<Client> {
    if (this.availableClients.length > 0) {
      return this.availableClients.pop()!
    }
    const client = await this.ftpManager.createSecondaryClient()
    this.clientPool.push(client)
    return client
  }

  private releaseClient(client: Client): void {
    if (this.clientPool.includes(client)) {
      this.availableClients.push(client)
    }
  }

  private removeClient(client: Client): void {
    try {
      client.close()
    } catch {
      // ignore
    }
    this.clientPool = this.clientPool.filter((c) => c !== client)
    this.availableClients = this.availableClients.filter((c) => c !== client)
  }

  private async processNext(): Promise<void> {
    if (this.active >= MAX_CONCURRENT || this.queue.length === 0) return
    const item = this.queue.shift()!
    this.active++

    let client: Client | null = null
    try {
      if (this.secondaryUnavailable) {
        // Secondary 생성 실패 이력이 있으면 즉시 null 반환 (메인 client 폴백 금지)
        item.resolve(null)
        return
      }

      try {
        client = await this.acquireClient()
      } catch (acquireErr) {
        // Secondary 생성 실패 → 이후 요청도 모두 null로 빠르게 응답
        this.secondaryUnavailable = true
        console.warn(
          '[RemoteGalleryPreviewQueue] secondary client unavailable:',
          acquireErr instanceof Error ? acquireErr.message : acquireErr
        )
        item.resolve(null)
        return
      }

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Folder preview timeout')), PREVIEW_TIMEOUT_MS)
      })

      const preview = await Promise.race([findFirstImage(client, item.remotePath), timeoutPromise])

      this.releaseClient(client)
      client = null

      // 결과를 영구 캐시. preview가 null인 경우(이미지 없음)도 저장하여 재방문 시 LIST 생략.
      // request 시점의 host/port를 사용(disconnect/reconnect 사이에도 안정적).
      this.cache.store(item.host, item.port, item.remotePath, preview)

      item.resolve(preview)
    } catch (err) {
      if (client) {
        this.removeClient(client)
        client = null
      }
      item.reject(err instanceof Error ? err : new Error(String(err)))
    } finally {
      this.active--
      void this.processNext()
    }
  }
}

async function findFirstImage(
  client: Client,
  remotePath: string
): Promise<RemoteFolderPreview | null> {
  const fileInfos = await client.list(remotePath)
  // Exclude the "." / ".." self/parent references from the item count.
  const entries = fileInfos.filter((fi) => fi.name !== '.' && fi.name !== '..')
  const itemCount = entries.length
  for (const fi of entries) {
    if (fi.isDirectory || fi.isSymbolicLink) continue
    if (!isImageFile(fi.name)) continue
    return {
      name: fi.name,
      size: fi.size,
      modifiedAt: fi.modifiedAt?.toISOString() ?? '',
      itemCount
    }
  }
  return null
}
