import { Client } from 'basic-ftp'
import { Writable } from 'stream'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
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

/** 썸네일을 받는 연결(세션의 매니저) */
export type ThumbnailSource = Pick<
  FtpConnectionManager,
  'getHost' | 'getPort' | 'getConnKey' | 'createSecondaryClient' | 'runOnMainClient'
>

type ReadyCallback = (result: ThumbnailResult) => void
type ErrorCallback = (cacheKey: string, error: string) => void

export class ThumbnailQueue {
  private queue: Array<ThumbnailRequest & { cacheKey: string }> = []
  private activeCount = 0
  /** 진행 중인 키 → 시작한 세대. cancelAll 뒤의 옛 세대 작업은 같은 키의 새 요청을 막지 않는다 */
  private processing = new Map<string, number>()
  /**
   * 뷰어(패널)별 직전 requestBatch의 키 → priority. 같은 뷰어의 다음 배치는 이 중 빠진 미시작 항목을
   * 버리되, 다른 뷰어가 아직 원하는 항목은 남긴다(multi-connection §4.3). 빈 배치는 항목을 두지 않는다.
   */
  private batches = new Map<string, Map<string, number>>()

  // FTP 클라이언트 풀
  private clientPool: Client[] = []
  private availableClients: Client[] = []
  private secondaryFailed = false // 보조 연결 불가 시 메인 클라이언트 사용
  /** cancelAll마다 증가. 작업이 시작할 때 읽은 값과 다르면 취소된 작업이다 */
  private generation = 0

  constructor(
    private ftpManager: ThumbnailSource,
    private generator: ThumbnailGenerator,
    private cacheManager: CacheManager,
    private onReady: ReadyCallback,
    private onError: ErrorCallback
  ) {}

  private get maxConcurrent(): number {
    // 보조 클라이언트 사용 불가 시 메인 클라이언트로 직렬 처리
    return this.secondaryFailed ? 1 : MAX_CONCURRENT
  }

  private cacheKeyOf(req: ThumbnailRequest): string {
    return generateCacheKey(
      this.ftpManager.getConnKey(),
      req.remotePath,
      req.fileSize,
      req.modifiedAt
    )
  }

  request(req: ThumbnailRequest): string {
    const cacheKey = this.cacheKeyOf(req)

    if (this.processing.get(cacheKey) === this.generation) return cacheKey
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

  /**
   * 그리드 뷰포트 배치. 그 뷰어의 직전 배치를 교체한다: 직전 배치로 들어와 아직 시작하지 않은 항목 중
   * 이번 배치에 없고 다른 뷰어도 원하지 않는 것은 버리고, 남는 항목은 원하는 뷰어들 중 가장 작은
   * priority로 재정렬한 뒤 새 항목을 넣는다. 진행 중인 다운로드와 단건 request()로만 들어온 항목은
   * 건드리지 않는다.
   */
  requestBatch(viewerId: string, requests: ThumbnailRequest[]): string[] {
    const keys = requests.map((req) => this.cacheKeyOf(req))
    const next = new Map(keys.map((key, i) => [key, requests[i].priority]))
    const prev = this.batches.get(viewerId)
    if (next.size > 0) this.batches.set(viewerId, next)
    else this.batches.delete(viewerId)
    if (prev) this.dropUnwanted(prev.keys())
    this.refreshPriorities(new Set([...(prev?.keys() ?? []), ...next.keys()]))
    // request()는 빈 슬롯이 있으면 바로 시작하므로 priority 순으로 넣는다(안정 정렬: 같은 값은 입력 순서)
    const ordered = [...requests].sort((a, b) => a.priority - b.priority)
    for (const req of ordered) this.request(req)
    return keys
  }

  /**
   * 뷰어의 배치를 잊고, 그 뷰어만 원하던 대기 항목을 버린다. 다른 뷰어의 배치가 남아 있으면 그들의
   * 대기·진행 항목과 클라이언트는 그대로 둔다. 남은 배치가 없으면(뷰어를 주지 않은 호출 포함) 전부
   * 취소한다: 대기·단건을 비우고 클라이언트를 닫고 세대를 올린다.
   */
  cancelAll(viewerId?: string): void {
    const prev = viewerId === undefined ? undefined : this.batches.get(viewerId)
    if (viewerId !== undefined) this.batches.delete(viewerId)
    if (viewerId !== undefined && this.batches.size > 0) {
      if (prev) this.dropUnwanted(prev.keys())
      return
    }
    this.batches.clear()
    this.queue = []
    this.generation++
    for (const client of this.clientPool) {
      client.close()
    }
    this.clientPool = []
    this.availableClients = []
    // 재연결/재시도 시 보조 클라이언트 사용을 다시 시도하도록 플래그 리셋
    this.secondaryFailed = false
  }

  /** `keys` 중 어느 뷰어의 현재 배치에도 없는 대기 항목을 버린다 */
  private dropUnwanted(keys: Iterable<string>): void {
    const candidates = new Set(keys)
    this.queue = this.queue.filter(
      (q) => !candidates.has(q.cacheKey) || this.wantedPriority(q.cacheKey) !== undefined
    )
  }

  /** 뷰어들이 원하는 priority 중 가장 작은 값. 아무도 원하지 않으면 undefined */
  private wantedPriority(key: string): number | undefined {
    let best: number | undefined
    for (const batch of this.batches.values()) {
      const p = batch.get(key)
      if (p !== undefined && (best === undefined || p < best)) best = p
    }
    return best
  }

  private refreshPriorities(keys: Set<string>): void {
    const priorities = new Map<string, number>()
    for (const key of keys) {
      const p = this.wantedPriority(key)
      if (p !== undefined) priorities.set(key, p)
    }
    this.updatePriorities(priorities)
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
    // 전역 플래그는 다음 항목이 되돌려 버리므로, 시작 시점의 세대로 취소 여부를 판단한다
    const generation = this.generation
    this.processing.set(item.cacheKey, generation)

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
      if (generation !== this.generation) {
        // cancelAll 뒤에 연결이 끝난 클라이언트는 비워진 풀에 들어가 아무도 닫지 않는다
        if (secondaryClient) this.removeClient(secondaryClient)
        return
      }

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
      if (generation !== this.generation) return

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

      if (generation === this.generation) {
        this.onError(item.cacheKey, errMsg)
      }
      if (secondaryClient) {
        this.removeClient(secondaryClient)
      }
    } finally {
      this.activeCount--
      // 같은 키를 새 세대가 다시 시작했으면 그 표시는 지우지 않는다
      if (this.processing.get(item.cacheKey) === generation) this.processing.delete(item.cacheKey)
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
