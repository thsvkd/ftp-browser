import { Writable } from 'stream'
import * as fs from 'fs'
import { Socket } from 'net'
import { TLSSocket } from 'tls'
import type { Client, FTPResponse } from 'basic-ftp'
import { BufferPool, DOWNLOAD_WRITE_BUFFER } from './fastTransfer'

/**
 * 평문 FTP 다운로드에서 데이터 소켓이 바로 읽어 넣는 슬랩 하나의 크기와 전송 하나가 쥐는 슬랩 수(4 MiB).
 * Electron 루프백 512 MiB 실측: 스트림 경로 0.17~0.19 s, 1 MiB x 4 슬랩 0.11 s(256 KiB x 8은 0.12 s).
 */
export const DOWNLOAD_SLAB = 1024 * 1024
export const DOWNLOAD_SLABS = 4
const slabs = new BufferPool(DOWNLOAD_SLAB, 4 * DOWNLOAD_SLABS)
/**
 * 슬랩마다 풀로 돌려주기 전에 끝나야 하는 것의 수: 소켓이 읽기 버퍼로 쥐고 있으면 1, 쓰기 콜백을 기다리는
 * 조각마다 1. 0이 되면 풀에 돌려준다. 'close' 없이 버려진 소켓의 슬랩도 GC가 거두도록 WeakMap이다.
 */
const slabRefs = new WeakMap<Buffer, number>()
/**
 * 채우는 중인 슬랩에 아직 넘기지 않은 첫 바이트가 들어온 때 타이머를 걸어, 이만큼 지나도 슬랩이 다 차지
 * 않았으면 그때까지 받은 부분을 디스크로 넘긴다. 다음 수신을 기다리지 않으므로 몰아 보내고 쉬는 서버에서도
 * 진행률이 이만큼 안에 오른다. 진행률(onProgress)이 슬랩이 찰 때만 오르면 느린 WAN 구간(1 MiB에 수 초)에서
 * 진행 막대와 속도가 멈춰 보인다. 연결당 500 KB/s로 깎는 서버는 64 KiB를 약 131 ms마다 보내므로, 이보다
 * 짧아야 묶음마다 넘겨 진행률 간격이 기존 스트림 경로(약 131 ms)와 같다(200 ms면 두 묶음씩 262 ms).
 * 빠른 링크에서는 슬랩이 1 ms 안에 차서 타이머가 울리기 전에 꺼지므로 꽉 찬 슬랩만 넘긴다.
 */
export const PARTIAL_SLAB_MS = 100

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
 * - 쓰기 하나가 진행되는 동안 쌓인 조각은 다음에 한 번의 writev로 쓴다(highWaterMark까지 쌓인다).
 * - 평문 FTP면 downloadInto가 데이터 소켓을 createSocket()으로 만들어, 소켓이 받은 바이트를 슬랩에 바로
 *   읽어 넣고 찬 슬랩(느린 링크면 PARTIAL_SLAB_MS 동안 받은 부분)을 write로 넘긴다.
 *   TLS는 basic-ftp의 스트림 경로 그대로다.
 */
export class SegmentWriter extends Writable {
  length: number
  written = 0
  overflow = false
  /** 진행 중인 위치 지정 쓰기. stop()이 이것이 끝나기를 기다린다. */
  private inflight: Promise<void> = Promise.resolve()
  private stopped = false
  /** 소켓이 놓았지만 쓰기가 끝나지 않아 풀로 돌아오지 않은 슬랩 수 */
  private slabsQueued = 0
  /** 쓰기를 기다리는 슬랩이 많아 멈춰 둔 소켓 */
  private paused = new Set<Socket>()
  /** 채우는 중인 슬랩을 넘기려고 걸어 둔 타이머. stop()이 모두 끈다. */
  private partialTimers = new Set<NodeJS.Timeout>()

  constructor(
    private readonly fd: number,
    private readonly range: SegmentRange,
    private readonly onProgress?: (bytes: number) => void,
    highWaterMark = DOWNLOAD_WRITE_BUFFER
  ) {
    super({ highWaterMark })
    this.length = range.end - range.start
  }

  /**
   * 받은 바이트를 풀에서 빌린 슬랩에 바로 읽어 넣는 데이터 소켓(onread). 수신마다 버퍼를 새로 잡거나 복사하지
   * 않는다. 슬랩이 차면 아직 넘기지 않은 부분을 write로 넘기고 소켓이 슬랩을 놓는다. 다 차기 전이라도 넘기지
   * 않은 첫 바이트가 들어온 뒤 PARTIAL_SLAB_MS가 지나면 타이머가 그때까지 받은 부분만 넘긴다. 이때 소켓은 같은
   * 슬랩의 나머지에 계속 읽어 넣으므로(libuv가 이미 그 자리를 읽기 버퍼로 쥐고 있다) 슬랩은 소켓이 놓고 모든
   * 조각의 쓰기 콜백이 온 뒤에야 풀에 돌려준다(slabRefs). 소켓이 놓았지만 돌아오지 않은 슬랩이
   * DOWNLOAD_SLABS - 1개면 소켓을 pause하고(TransferWatchdog은 멈춘 소켓을 우리 쪽 대기로 본다) 슬랩이 돌아올
   * 때 resume한다. 소켓이 읽기 버퍼로 쥔 슬랩은 EOF('end', Node가 읽기를 멈춘다) 뒤나 소켓이 닫힌('close')
   * 뒤에만 놓는다. 타이머는 슬랩을 넘기거나 놓을 때, stop()에서 끈다. basic-ftp가 리스너를 모두 떼고 닫으면
   * 그 슬랩은 풀로 돌아오지 않는다.
   */
  createSocket(): Socket {
    let slab: Buffer | undefined
    let fill = 0
    /** 슬랩에서 이미 write로 넘긴 끝 */
    let sent = 0
    let timer: NodeJS.Timeout | undefined
    const disarm = (): void => {
      if (!timer) return
      clearTimeout(timer)
      this.partialTimers.delete(timer)
      timer = undefined
    }
    const flushPartial = (): void => {
      this.partialTimers.delete(timer!)
      timer = undefined
      if (!slab || fill === sent) return
      this.submitPiece(slab, sent, fill)
      sent = fill
    }
    const letGo = (): void => {
      disarm()
      if (slab) this.releaseSlab(slab, true)
      slab = undefined
    }
    const socket: Socket = new Socket({
      onread: {
        // 핸들을 만들 때와 매 수신 뒤에 불린다. 반환한 자리에 libuv가 바로 읽어 넣는다.
        buffer: () => {
          if (!slab) {
            slab = slabs.take()
            slabRefs.set(slab, 1)
            fill = 0
            sent = 0
          }
          return slab.subarray(fill)
        },
        callback: (n: number) => {
          // writer가 끝났으면 같은 자리에 받아 버린다
          if (!slab || this.stopped || this.destroyed || this.writableEnded) return true
          if (fill === sent) {
            timer = setTimeout(flushPartial, PARTIAL_SLAB_MS)
            this.partialTimers.add(timer)
          }
          fill += n
          if (fill === slab.length) {
            this.submitPiece(slab, sent, fill)
            letGo()
            if (this.slabsQueued >= DOWNLOAD_SLABS - 1) {
              this.paused.add(socket)
              socket.pause()
            }
          }
          return true
        }
      }
    })
    // basic-ftp의 pipeline이 writer.end()를 부르는 'end' 리스너보다 먼저 등록되므로 남은 부분이 먼저 들어간다
    socket.once('end', () => {
      this.paused.delete(socket)
      if (slab && fill > sent) this.submitPiece(slab, sent, fill)
      letGo()
    })
    socket.once('close', () => {
      this.paused.delete(socket)
      letGo()
    })
    return socket
  }

  /** 슬랩의 [from, to)를 write로 넘긴다. 쓰기 콜백이 올 때까지 슬랩을 풀에 돌려주지 않는다. */
  private submitPiece(slab: Buffer, from: number, to: number): void {
    if (this.stopped || this.destroyed || this.writableEnded) return
    slabRefs.set(slab, slabRefs.get(slab)! + 1)
    // 콜백은 쓰기가 끝났거나(에러 포함) 시작 전에 버려졌을 때만 온다: 그때는 fs가 그 조각을 쓰지 않는다
    this.write(slab.subarray(from, to), () => this.releaseSlab(slab, false))
  }

  /** 슬랩의 참조 하나(소켓이 놓음 또는 조각 하나의 쓰기 끝)를 푼다. 남은 참조가 없으면 풀에 돌려준다. */
  private releaseSlab(slab: Buffer, socketLetGo: boolean): void {
    if (socketLetGo) this.slabsQueued++
    const refs = slabRefs.get(slab)! - 1
    if (refs > 0) {
      slabRefs.set(slab, refs)
      return
    }
    slabRefs.delete(slab)
    slabs.give(slab)
    this.slabsQueued--
    if (this.slabsQueued < DOWNLOAD_SLABS - 1 && this.paused.size > 0) {
      for (const socket of this.paused) socket.resume()
      this.paused.clear()
    }
  }

  /** 이 구간이 정확히 len 바이트를 받았는지. */
  get complete(): boolean {
    return this.written === this.length
  }

  /**
   * 이후 청크는 버리고 채우는 중인 슬랩의 타이머를 끈 뒤, 진행 중인 쓰기가 끝나면 resolve한다. downloadTo가 소켓 에러로 먼저
   * reject되어도 스레드풀의 fs.write는 남아 있을 수 있으므로, fd를 닫기 전에 반드시 기다린다.
   * 닫힌 fd 번호가 다른 파일에 재사용된 뒤 늦은 쓰기가 그 파일을 덮는 일을 막는다.
   */
  stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.partialTimers) clearTimeout(timer)
    this.partialTimers.clear()
    return this.inflight
  }

  /**
   * 한 스트림으로 받던 최종 구간을 end에서 끝나는 비최종 구간으로 바꾼다. end는 이미 받아 둔 바이트
   * (start + written + writableLength) 뒤여야 한다. writableLength에는 진행 중인 쓰기도 들어 있으므로
   * 그 쓰기가 계산해 둔 take가 새 경계를 넘지 않는다. range는 구간 항목과 같은 객체라 재시도도 새 경계를 쓴다.
   */
  splitAt(end: number): void {
    this.range.end = end
    this.range.final = false
    this.length = end - this.range.start
  }

  /** Node는 조각 하나도 _writev([chunk])로 넘기므로 쓰기 경로는 이것 하나다. */
  _writev(chunks: Array<{ chunk: Buffer }>, callback: (error?: Error | null) => void): void {
    if (this.stopped) return callback()
    const room = this.length - this.written
    // room에서 자른다: 비최종 구간의 나머지는 다음 구간의 몫이고, 최종 구간이면 overflow다
    const buffers: Buffer[] = []
    let total = 0
    let take = 0
    for (const { chunk } of chunks) {
      total += chunk.length
      const part = Math.min(chunk.length, room - take)
      if (part <= 0) continue
      buffers.push(part === chunk.length ? chunk : chunk.subarray(0, part))
      take += part
    }
    const exhausted = total >= room

    this.inflight = this.writeFully(buffers, take)
      .then(() => {
        this.written += take
        if (take > 0) this.onProgress?.(take)

        if (!exhausted) return callback()
        if (this.range.final) {
          // 정확히 len에서 끝나면 정상. 그보다 많이 왔을 때만 overflow다.
          if (total === room) return callback()
          this.overflow = true
          return callback(
            segmentError(SEGMENT_OVERFLOW, 'Final segment received more bytes than expected')
          )
        }
        callback(segmentError(SEGMENT_DONE, 'Segment complete'))
      })
      .catch((err) => callback(err as Error))
  }

  /** fs.writev는 일부만 쓸 수 있으므로 다 쓴 버퍼는 빼고 걸친 버퍼는 잘라 take 바이트를 다 쓸 때까지 반복한다. */
  private async writeFully(buffers: Buffer[], take: number): Promise<void> {
    let done = 0
    while (done < take) {
      let skip = done
      const rest: Buffer[] = []
      for (const buffer of buffers) {
        if (skip >= buffer.length) {
          skip -= buffer.length
          continue
        }
        rest.push(skip > 0 ? buffer.subarray(skip) : buffer)
        skip = 0
      }
      const bytes = await new Promise<number>((resolve, reject) => {
        fs.writev(this.fd, rest, this.range.start + this.written + done, (err, n) =>
          err ? reject(err) : resolve(n)
        )
      })
      // 에러 없이 0 바이트면 같은 쓰기를 끝없이 되풀이하게 된다
      if (bytes === 0) throw new Error(`writev wrote 0 bytes of ${take - done}`)
      done += bytes
    }
  }
}

/** downloadInto가 데이터 소켓 생성 함수를 바꿔 둔 제어 연결과, 그 연결에서 지금 받는 writer */
const hooked = new WeakSet<object>()
const receivers = new WeakMap<object, SegmentWriter>()

/**
 * client.downloadTo(writer, remotePath, startAt)와 같다. 평문 FTP면 basic-ftp가 수동 모드 연결에 쓰는 데이터
 * 소켓을 writer.createSocket()으로 만들어 슬랩에 바로 받는다. 명령 순서, EPSV→PASV fallback, REST는 basic-ftp
 * 그대로다. TLS는 기존 소켓을 감싸면 onread가 무시되므로(Node tls.connect의 socket 옵션) 스트림 경로로 받는다.
 */
export async function downloadInto(
  client: Client,
  writer: SegmentWriter,
  remotePath: string,
  startAt = 0
): Promise<FTPResponse> {
  const ftp = client.ftp
  if (ftp.socket instanceof TLSSocket) return client.downloadTo(writer, remotePath, startAt)
  // 연결마다 한 번만 바꾼다. 파일마다 속성을 지우면 V8이 객체를 느린 사전 모드로 바꿀 수 있다.
  if (!hooked.has(ftp)) {
    hooked.add(ftp)
    const plain = ftp._newSocket.bind(ftp)
    ftp._newSocket = () => receivers.get(ftp)?.createSocket() ?? plain()
  }
  receivers.set(ftp, writer)
  try {
    return await client.downloadTo(writer, remotePath, startAt)
  } finally {
    receivers.delete(ftp)
  }
}
