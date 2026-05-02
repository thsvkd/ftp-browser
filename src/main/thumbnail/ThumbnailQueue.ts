import { Client } from 'basic-ftp'
import { Writable } from 'stream'
import { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import { ThumbnailGenerator } from './ThumbnailGenerator'
import { CacheManager } from './CacheManager'
import { generateCacheKey } from '../utils/cacheKey'
import { classifyError } from '../utils/errorClassifier'
import { MAX_IMAGE_SIZE_BYTES } from '@shared/constants'

const DOWNLOAD_TIMEOUT_MS = 30_000
const MAX_CONCURRENT = 3

export interface ThumbnailRequest {
  remotePath: string
  fileName: string
  fileSize: number
  modifiedAt: string
  priority: number
}

export interface ThumbnailResult {
  cacheKey: string
  dataUrl: string
  width: number
  height: number
  fromCache: boolean
}

type ReadyCallback = (result: ThumbnailResult) => void
type ErrorCallback = (cacheKey: string, error: string) => void

export class ThumbnailQueue {
  private queue: Array<ThumbnailRequest & { cacheKey: string }> = []
  private activeCount = 0
  private processing = new Set<string>()

  // FTP 클라이언트 풀
  private clientPool: Client[] = []
  private availableClients: Client[] = []
  private secondaryFailed = false // 보조 연결 불가 시 메인 클라이언트 사용
  private aborted = false

  constructor(
    private ftpManager: FtpConnectionManager,
    private generator: ThumbnailGenerator,
    private cacheManager: CacheManager,
    private onReady: ReadyCallback,
    private onError: ErrorCallback
  ) {}

  private get maxConcurrent(): number {
    // 보조 클라이언트 사용 불가 시 메인 클라이언트로 직렬 처리
    return this.secondaryFailed ? 1 : MAX_CONCURRENT
  }

  request(req: ThumbnailRequest): string {
    const cacheKey = generateCacheKey(
      this.ftpManager.getHost(),
      this.ftpManager.getPort(),
      req.remotePath,
      req.fileSize,
      req.modifiedAt
    )

    if (this.processing.has(cacheKey)) return cacheKey
    if (this.queue.some((q) => q.cacheKey === cacheKey)) return cacheKey

    // Check cache first (synchronous)
    const cached = this.cacheManager.lookup(cacheKey)
    if (cached) {
      const data = this.cacheManager.readThumbnail(cached)
      this.onReady({
        cacheKey,
        dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`,
        width: cached.width,
        height: cached.height,
        fromCache: true
      })
      return cacheKey
    }

    if (req.fileSize > MAX_IMAGE_SIZE_BYTES) {
      return cacheKey
    }

    this.queue.push({ ...req, cacheKey })
    this.queue.sort((a, b) => a.priority - b.priority)
    this.processNext()
    return cacheKey
  }

  cancelAll(): void {
    this.queue = []
    this.aborted = true
    for (const client of this.clientPool) {
      client.close()
    }
    this.clientPool = []
    this.availableClients = []
    // 재연결/재시도 시 보조 클라이언트 사용을 다시 시도하도록 플래그 리셋
    this.secondaryFailed = false
  }

  updatePriorities(priorities: Map<string, number>): void {
    for (const item of this.queue) {
      const p = priorities.get(item.cacheKey)
      if (p !== undefined) item.priority = p
    }
    this.queue.sort((a, b) => a.priority - b.priority)
  }

  /**
   * 보조 클라이언트를 풀에서 가져오거나 새로 생성한다. 실패하면 null을 반환하고
   * caller가 메인 클라이언트(runOnMainClient) 경로로 fallback해야 한다.
   */
  private async acquireSecondaryClient(): Promise<Client | null> {
    if (this.secondaryFailed) return null

    if (this.availableClients.length > 0) {
      return this.availableClients.pop()!
    }

    try {
      const client = await this.ftpManager.createSecondaryClient()
      this.clientPool.push(client)
      return client
    } catch (err) {
      console.warn('[Thumbnail] Secondary FTP client failed, falling back to main client:', err)
      this.secondaryFailed = true
      return null
    }
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
    if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) return

    const item = this.queue.shift()!
    this.activeCount++
    this.processing.add(item.cacheKey)
    this.aborted = false

    let secondaryClient: Client | null = null

    try {
      // Double-check cache
      const cached = this.cacheManager.lookup(item.cacheKey)
      if (cached) {
        const data = this.cacheManager.readThumbnail(cached)
        this.onReady({
          cacheKey: item.cacheKey,
          dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`,
          width: cached.width,
          height: cached.height,
          fromCache: true
        })
        return
      }

      secondaryClient = await this.acquireSecondaryClient()
      if (this.aborted) return

      let buffer: Buffer
      if (secondaryClient) {
        try {
          buffer = await this.downloadFileWithTimeout(secondaryClient, item.remotePath)
          this.releaseClient(secondaryClient)
          secondaryClient = null
        } catch (err) {
          if (secondaryClient) {
            this.removeClient(secondaryClient)
            secondaryClient = null
          }
          throw err
        }
      } else {
        // 메인 클라이언트 fallback. runOnMainClient를 통해 list/transfer/delete 등과
        // 직렬화하여 "Client is closed because user launched task while another one
        // is still running" 충돌을 방지한다.
        buffer = await this.ftpManager.runOnMainClient((client) =>
          this.downloadFileNoTimeout(client, item.remotePath)
        )
      }
      if (this.aborted) return

      const format = await this.generator.getFormat(buffer)
      const generated = await this.generator.generate(buffer)

      this.cacheManager.store({
        cacheKey: item.cacheKey,
        host: this.ftpManager.getHost(),
        port: this.ftpManager.getPort(),
        remotePath: item.remotePath,
        fileSize: item.fileSize,
        modifiedAt: item.modifiedAt,
        width: generated.width,
        height: generated.height,
        originalFormat: format,
        thumbnailBuffer: generated.buffer
      })

      this.onReady({
        cacheKey: item.cacheKey,
        dataUrl: `data:image/jpeg;base64,${generated.buffer.toString('base64')}`,
        width: generated.width,
        height: generated.height,
        fromCache: false
      })
    } catch (err) {
      const { message: errMsg } = classifyError(err)
      console.error(`[Thumbnail] Error processing ${item.remotePath}:`, errMsg)

      if (!this.aborted) {
        this.onError(item.cacheKey, errMsg)
      }
      if (secondaryClient) {
        this.removeClient(secondaryClient)
      }
    } finally {
      this.activeCount--
      this.processing.delete(item.cacheKey)
      this.processNext()
    }
  }

  /**
   * 보조 클라이언트 전용 다운로드. timeout이 발생하면 caller가 client를 close하여
   * stuck된 task를 강제 종료해야 한다 (별도 연결이라 다른 task에 영향 없음).
   */
  private async downloadFileWithTimeout(client: Client, remotePath: string): Promise<Buffer> {
    const chunks: Buffer[] = []
    const writable = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk)
        callback()
      }
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Download timeout')), DOWNLOAD_TIMEOUT_MS)
    })

    try {
      await Promise.race([client.downloadTo(writable, remotePath), timeoutPromise])
      return Buffer.concat(chunks)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 메인 클라이언트 전용 다운로드. Promise.race timeout을 쓰면 timeout이 win한 뒤에도
   * underlying FTP task가 계속 돌아가 다음 runOnMainClient task와 충돌하므로 사용 금지.
   * basic-ftp Client 자체의 30s timeout(CLIENT_TIMEOUT_MS)에 위임한다.
   */
  private async downloadFileNoTimeout(client: Client, remotePath: string): Promise<Buffer> {
    const chunks: Buffer[] = []
    const writable = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk)
        callback()
      }
    })
    await client.downloadTo(writable, remotePath)
    return Buffer.concat(chunks)
  }
}
