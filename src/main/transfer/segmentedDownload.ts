import { Writable } from 'stream'
import * as fs from 'fs'

/** 이 크기(64 MiB) 이상인 다운로드만 구간 분할 대상으로 삼는다. 테스트는 planSegments 인자로 낮춘다. */
export const SEGMENT_MIN = 64 * 1024 * 1024
/** 세그먼트 하나가 맡는 목표 크기. 구간 수는 ceil(size / SEGMENT_SIZE)를 풀 한도로 자른 값이다. */
export const SEGMENT_SIZE = 64 * 1024 * 1024

/** 비최종 구간이 정확히 len 바이트를 채워 의도적으로 스트림을 끊을 때 콜백 에러에 실리는 코드. */
export const SEGMENT_DONE = 'SEGMENT_DONE'
/** 최종 구간이 len을 넘겨 받았을 때(서버가 REST를 무시한 경우) 실리는 코드. */
export const SEGMENT_OVERFLOW = 'SEGMENT_OVERFLOW'

/** [start, end) 바이트 구간. final은 EOF까지 자연 종료(226)하는 마지막 구간이다. */
export interface SegmentRange {
  start: number
  end: number
  final: boolean
}

/**
 * 파일을 구간으로 나눈다. 분할하지 않는 편이 나으면(빈 배열) 단일 스트림으로 받는다.
 * 구간은 [0, size)를 빈틈·겹침 없이 덮고, 나머지 바이트는 앞 구간에 1바이트씩 나눠
 * 구간 길이 차이가 1을 넘지 않게 한다.
 */
export function planSegments(
  size: number,
  limit: number,
  minSize: number = SEGMENT_MIN,
  segmentSize: number = SEGMENT_SIZE
): SegmentRange[] {
  if (limit < 2 || size < minSize) return []
  const count = Math.min(limit, Math.ceil(size / segmentSize))
  if (count < 2) return []

  const base = Math.floor(size / count)
  const extra = size % count
  const ranges: SegmentRange[] = []
  let start = 0
  for (let i = 0; i < count; i++) {
    const end = start + base + (i < extra ? 1 : 0)
    ranges.push({ start, end, final: i === count - 1 })
    start = end
  }
  return ranges
}

function segmentError(code: string, message: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(message)
  err.code = code
  return err
}

/**
 * 이미 열린 fd의 range.start 위치부터 위치 지정 쓰기(pwrite)를 하는 Writable.
 * basic-ftp `downloadTo(writer, remotePath, range.start)`의 대상으로 쓴다.
 *
 * - 비최종 구간: len에 닿으면 잘라 쓴 뒤 콜백 에러(SEGMENT_DONE)로 스트림을 끊는다.
 *   FTP RETR에는 끝 오프셋이 없어 이렇게 끊을 수밖에 없고, basic-ftp는 이때 클라이언트를
 *   closeWithError 하므로 호출자는 written === len이면 성공으로 보고 그 클라이언트를 버린다.
 * - 최종 구간: len까지만 쓰고, 더 오면 overflow로 표시하며 SEGMENT_OVERFLOW로 끊는다.
 *   서버가 REST를 무시하고 0부터 보낼 때 나타난다.
 * - onProgress에는 실제로 쓴 바이트 수(증분)를 넘긴다.
 */
export class SegmentWriter extends Writable {
  readonly length: number
  written = 0
  overflow = false
  /** 진행 중인 위치 지정 쓰기. stop()이 이것이 끝나기를 기다린다. */
  private inflight: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(
    private readonly fd: number,
    private readonly range: SegmentRange,
    private readonly onProgress?: (bytes: number) => void
  ) {
    super()
    this.length = range.end - range.start
  }

  /** 이 구간이 정확히 len 바이트를 받았는지. */
  get complete(): boolean {
    return this.written === this.length
  }

  /**
   * 이후 청크는 버리고, 진행 중인 쓰기가 끝나면 resolve한다. downloadTo가 소켓 에러로 먼저
   * reject되어도 스레드풀의 fs.write는 남아 있을 수 있으므로, fd를 닫기 전에 반드시 기다린다.
   * 닫힌 fd 번호가 다른 파일에 재사용된 뒤 늦은 쓰기가 그 파일을 덮는 일을 막는다.
   */
  stop(): Promise<void> {
    this.stopped = true
    return this.inflight
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.stopped) return callback()
    const room = this.length - this.written
    const take = Math.min(chunk.length, room)
    const exhausted = chunk.length >= room

    this.inflight = this.writeFully(chunk, take)
      .then(() => {
        this.written += take
        if (take > 0) this.onProgress?.(take)

        if (!exhausted) return callback()
        if (this.range.final) {
          // 정확히 len에서 끝나면 정상. 그보다 많이 왔을 때만 overflow다.
          if (chunk.length === room) return callback()
          this.overflow = true
          return callback(
            segmentError(SEGMENT_OVERFLOW, 'Final segment received more bytes than expected')
          )
        }
        callback(segmentError(SEGMENT_DONE, 'Segment complete'))
      })
      .catch((err) => callback(err as Error))
  }

  /** fs.write는 일부만 쓸 수 있으므로 take 바이트를 다 쓸 때까지 반복한다. */
  private async writeFully(chunk: Buffer, take: number): Promise<void> {
    let done = 0
    while (done < take) {
      const bytes = await new Promise<number>((resolve, reject) => {
        fs.write(
          this.fd,
          chunk,
          done,
          take - done,
          this.range.start + this.written + done,
          (err, n) => (err ? reject(err) : resolve(n))
        )
      })
      done += bytes
    }
  }
}
