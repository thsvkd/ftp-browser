import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { Client } from 'basic-ftp'
import { FtpFileOperations } from '../ftp/FtpFileOperations'
import type { FtpConnectionManager } from '../ftp/FtpConnectionManager'
import {
  DOWNLOAD_SLAB,
  DOWNLOAD_SLABS,
  PARTIAL_SLAB_MS,
  SegmentWriter,
  downloadInto,
  SEGMENT_DONE,
  SEGMENT_OVERFLOW
} from '../ftp/segmentWriter'
import {
  startMockFtpServer,
  type MockFtpServer,
  type MockFtpServerOptions
} from './__fixtures__/mockFtpServer'

// 느린 디스크를 흉내 내려고 fs.writev를 갈아 끼울 수 있게 감싼다(ESM의 fs는 spyOn으로 바꿀 수 없다).
// hooks.writev가 없으면 실제 fs 그대로다. callback으로 쓰지 않고 결과를 바로 줄 수도 있다.
type WritevCallback = (err: Error | null, bytes: number) => void
const hooks = vi.hoisted(() => ({
  writev: undefined as undefined | ((write: () => void, callback: WritevCallback) => void)
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const writev = (...args: unknown[]): void => {
    const write = (): void => (actual.writev as (...a: unknown[]) => void)(...args)
    if (hooks.writev) hooks.writev(write, args[args.length - 1] as WritevCallback)
    else write()
  }
  return { ...actual, writev }
})

const KiB = 1024
const MiB = 1024 * KiB
const SLAB = DOWNLOAD_SLAB

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 구간이 엉뚱한 위치에 써지면 해시가 반드시 달라지는 의사 난수 내용 */
function content(size: number, seed: number): Buffer {
  const data = Buffer.alloc(size)
  let x = seed >>> 0
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    data[i] = x >>> 24
  }
  return data
}

describe('slab download against a mock FTP server', () => {
  let server: MockFtpServer
  const clients: Client[] = []
  let dir: string
  const ops = new FtpFileOperations({} as FtpConnectionManager)

  /** 앱(createConfiguredClient)과 같은 설정으로 붙는다 */
  async function login(options: { tls?: boolean; timeout?: number } = {}): Promise<Client> {
    const client = new Client(options.timeout ?? 10_000, { allowSeparateTransferHost: false })
    clients.push(client)
    client.ftp.ipFamily = 4
    await client.access({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      password: 'p',
      secure: options.tls,
      secureOptions: options.tls ? { rejectUnauthorized: false } : undefined
    })
    return client
  }

  async function connect(
    file: Buffer,
    options: {
      tls?: boolean
      timeout?: number
      ignoreRest?: boolean
      retrPace?: MockFtpServerOptions['retrPace']
    } = {}
  ): Promise<Client> {
    server = await startMockFtpServer({
      file,
      tls: options.tls,
      ignoreRest: options.ignoreRest,
      retrPace: options.retrPace
    })
    return login(options)
  }

  /** 구간 쓰기용으로 size 크기의 빈 로컬 파일을 연다 */
  async function sparse(name: string, size: number): Promise<fs.promises.FileHandle> {
    const file = await fs.promises.open(path.join(dir, name), 'w')
    await file.truncate(size)
    return file
  }

  function slabAllocations(alloc: { mock: { calls: unknown[][] } }): number {
    return alloc.mock.calls.filter(([size]) => size === SLAB).length
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slabdl-'))
  })

  afterEach(async () => {
    hooks.writev = undefined
    vi.restoreAllMocks()
    for (const client of clients.splice(0)) client.close()
    await server?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const SIZES = [0, 1, SLAB - 1, SLAB, SLAB + 1, 8 * SLAB + 17, 5 * MiB + 3]
  for (const tls of [false, true]) {
    for (const size of SIZES) {
      // 빈 파일의 FTPS 다운로드는 이 목 서버와 원래 경로에서도 실패한다(데이터 연결의 TLS가 열리기 전에 닫힌다)
      if (tls && size === 0) continue
      it(`should download ${size} bytes byte-identical with progress (tls=${tls})`, async () => {
        const data = content(size, size + 7)
        const client = await connect(data, { tls })
        const local = path.join(dir, 'out.bin')
        let reported = 0

        await ops.download('/f', local, (p) => (reported = p.bytes), client)

        expect(sha256(fs.readFileSync(local))).toBe(sha256(data))
        expect(reported).toBe(size)
      })
    }
  }

  it('should read into pooled slabs on plain FTP and keep the stream path over FTPS', async () => {
    const data = content(3 * SLAB + 5, 3)
    const plain = await connect(data)
    const createSocket = vi.spyOn(SegmentWriter.prototype, 'createSocket')
    const local = path.join(dir, 'out.bin')

    await ops.download('/f', local, undefined, plain)
    await ops.download('/f', local, undefined, plain)

    expect(sha256(fs.readFileSync(local))).toBe(sha256(data))
    expect(createSocket).toHaveBeenCalledTimes(2)
    // 데이터 소켓을 만드는 함수는 컨텍스트마다 한 번만 바꾼다
    expect(Object.hasOwn(plain.ftp, '_newSocket')).toBe(true)
    createSocket.mockClear()

    await server.close()
    const secure = await connect(data, { tls: true })
    await ops.download('/f', local, undefined, secure)

    expect(sha256(fs.readFileSync(local))).toBe(sha256(data))
    // TLS는 기존 소켓을 감싸면 onread를 쓰지 못하므로 basic-ftp의 소켓을 그대로 쓴다
    expect(createSocket).not.toHaveBeenCalled()
    expect(Object.hasOwn(secure.ftp, '_newSocket')).toBe(false)
  })

  it('should pause the socket for a slow disk and reuse slabs across downloads', async () => {
    const data = content(6 * MiB + 5, 99)
    const client = await connect(data)
    let writes = 0
    hooks.writev = (write) => {
      writes++
      setTimeout(write, 3)
    }
    const pause = vi.spyOn(net.Socket.prototype, 'pause')
    const alloc = vi.spyOn(Buffer, 'allocUnsafeSlow')

    for (let i = 0; i < 4; i++) {
      const local = path.join(dir, `slow-${i}.bin`)
      await ops.download('/f', local, undefined, client)
      expect(sha256(fs.readFileSync(local))).toBe(sha256(data))
    }

    expect(writes).toBeGreaterThan(4)
    expect(pause).toHaveBeenCalled()
    // 첫 다운로드가 풀을 채우고 나면 새로 할당하지 않는다: 소켓이 쥔 슬랩 하나 + 쓰기를 기다리는 슬랩들
    expect(slabAllocations(alloc)).toBeLessThanOrEqual(DOWNLOAD_SLABS + 1)
  })

  it('should not trip the data watchdog while a slow disk holds the socket paused', async () => {
    const data = content(4 * MiB, 5)
    const client = await connect(data, { timeout: 300 })
    let n = 0
    // 처음 몇 번의 쓰기를 timeout보다 오래 붙잡는다
    hooks.writev = (write) => setTimeout(write, n++ < 3 ? 700 : 0)
    const local = path.join(dir, 'wd.bin')

    await ops.download('/f', local, undefined, client)

    expect(sha256(fs.readFileSync(local))).toBe(sha256(data))
  }, 20_000)

  it('should report progress while a slow segment is still filling its first slab', async () => {
    // 10 ms마다 16 KiB(약 1.6 MB/s): 슬랩 하나(1 MiB)를 채우기 전에 전송이 끝난다
    const data = content(768 * KiB, 51)
    const client = await connect(data, { retrPace: { bytes: 16 * KiB, ms: 10 } })
    const file = await sparse('slow.bin', data.length)
    const range = { start: 0, end: data.length, final: true }
    const reports: number[] = []
    const writer = new SegmentWriter(file.fd, range, (bytes) => reports.push(bytes))

    await downloadInto(client, writer, '/f', 0)
    await writer.stop()
    await file.close()

    expect(sha256(fs.readFileSync(path.join(dir, 'slow.bin')))).toBe(sha256(data))
    expect(reports.reduce((a, b) => a + b, 0)).toBe(data.length)
    // 끝에 한 번이 아니라, 채우는 중인 슬랩을 PARTIAL_SLAB_MS마다 디스크로 넘기며 진행률을 낸다
    expect(reports.length).toBeGreaterThanOrEqual(2)
  })

  /** 받는 동안 진행률이 오른 시각(ms, 시작 기준)과 증분을 모은다 */
  async function pacedDownload(
    data: Buffer,
    retrPace: { bytes: number; ms: number },
    name: string
  ): Promise<Array<{ at: number; bytes: number }>> {
    const client = await connect(data, { retrPace })
    const file = await sparse(name, data.length)
    const range = { start: 0, end: data.length, final: true }
    const reports: Array<{ at: number; bytes: number }> = []
    const t0 = performance.now()
    const writer = new SegmentWriter(file.fd, range, (bytes) =>
      reports.push({ at: performance.now() - t0, bytes })
    )

    await downloadInto(client, writer, '/f', 0)
    await writer.stop()
    await file.close()

    expect(sha256(fs.readFileSync(path.join(dir, name)))).toBe(sha256(data))
    expect(reports.reduce((a, r) => a + r.bytes, 0)).toBe(data.length)
    return reports
  }

  it('should report a burst within PARTIAL_SLAB_MS even when no more data follows for a while', async () => {
    // 300 KiB를 한 번에 보내고 1.5 s 쉰다: 다음 수신을 기다리지 않고 타이머로 넘겨야 한다
    const reports = await pacedDownload(
      content(600 * KiB, 61),
      { bytes: 300 * KiB, ms: 1500 },
      'burst.bin'
    )

    expect(reports[0].at).toBeLessThan(PARTIAL_SLAB_MS + 400)
    expect(reports[0].bytes).toBe(300 * KiB)
  })

  it('should report every burst of a rate-limited server about as often as the server sends', async () => {
    // 연결당 500 KB/s로 깎는 서버처럼 64 KiB를 131 ms마다 보낸다(벤치 'slow=80:500'의 모양)
    const reports = await pacedDownload(
      content(12 * 64 * KiB, 63),
      { bytes: 64 * KiB, ms: 131 },
      'paced.bin'
    )

    const gaps = reports.slice(1).map((r, i) => r.at - reports[i].at)
    gaps.sort((a, b) => a - b)
    expect(reports.length).toBeGreaterThanOrEqual(10)
    expect(gaps[Math.floor(gaps.length / 2)]).toBeLessThanOrEqual(150)
  })

  it('should give back a slab handed over in pieces only after its last piece is written', async () => {
    // 느린 링크 + 느린 디스크: 한 슬랩의 앞 조각이 디스크에 쓰이는 중에 같은 슬랩의 뒤 조각이 큐에 쌓인다
    hooks.writev = (write) => setTimeout(write, 150)
    const data = content(2 * SLAB + 5, 65)
    await pacedDownload(data, { bytes: 256 * KiB, ms: 60 }, 'pieces-1.bin')
    await server.close()

    const alloc = vi.spyOn(Buffer, 'allocUnsafeSlow')
    await pacedDownload(data, { bytes: 256 * KiB, ms: 60 }, 'pieces-2.bin')

    // 슬랩이 모두 풀로 돌아왔으므로 두 번째 다운로드는 새로 할당하지 않는다
    expect(slabAllocations(alloc)).toBe(0)
  })

  it('should leave no partial-slab timer behind after a slow download', async () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    await pacedDownload(content(200 * KiB, 67), { bytes: 50 * KiB, ms: 30 }, 'timer.bin')
    await server.close()
    for (const client of clients.splice(0)) client.close()
    await new Promise((r) => setImmediate(r))

    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    expect(after).toBeLessThanOrEqual(before)
  })

  it('should hand only full slabs to the disk on a fast link', async () => {
    const data = content(5 * MiB + 3, 53)
    const client = await connect(data)
    const file = await sparse('fast.bin', data.length)
    const range = { start: 0, end: data.length, final: true }
    const reports: number[] = []
    const writer = new SegmentWriter(file.fd, range, (bytes) => reports.push(bytes))

    await downloadInto(client, writer, '/f', 0)
    await writer.stop()
    await file.close()

    expect(sha256(fs.readFileSync(path.join(dir, 'fast.bin')))).toBe(sha256(data))
    // 쓰기 하나에 여러 슬랩이 묶일 수 있지만, 마지막 조각 말고는 모두 꽉 찬 슬랩이다
    expect(reports.slice(0, -1).every((bytes) => bytes % SLAB === 0)).toBe(true)
  })

  it('should fail a write that fs.writev reports as 0 bytes instead of retrying it forever', async () => {
    hooks.writev = (_write, callback) => setImmediate(() => callback(null, 0))
    const file = await sparse('zero.bin', 10)
    const writer = new SegmentWriter(file.fd, { start: 0, end: 10, final: true })
    const failed = new Promise<Error>((resolve) => writer.once('error', resolve))

    writer.write(Buffer.alloc(10, 1))
    const err = await failed
    await writer.stop()
    await file.close()

    expect(err.message).toMatch(/0 bytes/)
    expect(writer.written).toBe(0)
  })

  it('should stop a non-final segment exactly at its length', async () => {
    const data = content(5 * MiB, 11)
    const client = await connect(data)
    const file = await sparse('seg.bin', data.length)
    const range = { start: 3 * SLAB + 5, end: 3 * SLAB + 5 + MiB + 3, final: false }
    const writer = new SegmentWriter(file.fd, range)

    const err = await downloadInto(client, writer, '/f', range.start).catch((e: unknown) => e)
    await writer.stop()
    await file.close()

    expect((err as NodeJS.ErrnoException).code).toBe(SEGMENT_DONE)
    expect(writer.written).toBe(range.end - range.start)
    const got = fs.readFileSync(path.join(dir, 'seg.bin'))
    expect(sha256(got.subarray(range.start, range.end))).toBe(
      sha256(data.subarray(range.start, range.end))
    )
    expect(got.subarray(range.end).equals(Buffer.alloc(data.length - range.end))).toBe(true)
  })

  it('should report overflow on a final segment when the server ignores REST', async () => {
    const data = content(3 * SLAB + 9, 21)
    const client = await connect(data, { ignoreRest: true })
    const file = await sparse('overflow.bin', data.length)
    const range = { start: 2 * SLAB + 3, end: data.length, final: true }
    const writer = new SegmentWriter(file.fd, range)

    const err = await downloadInto(client, writer, '/f', range.start).catch((e: unknown) => e)
    await writer.stop()
    await file.close()

    expect((err as NodeJS.ErrnoException).code).toBe(SEGMENT_OVERFLOW)
    expect(writer.overflow).toBe(true)
    expect(writer.written).toBe(range.end - range.start)
    // 서버가 0부터 보냈으므로 구간에는 파일 앞부분이 들어 있다
    const got = fs.readFileSync(path.join(dir, 'overflow.bin'))
    expect(got.subarray(range.start).equals(data.subarray(0, range.end - range.start))).toBe(true)
  })

  it('should cut a single stream at splitAt while the socket holds a partly filled slab', async () => {
    const data = content(5 * MiB + 3, 31)
    const client = await connect(data)
    const file = await sparse('split.bin', data.length)
    const range = { start: 0, end: data.length, final: true }
    let cut = 0
    const writer: SegmentWriter = new SegmentWriter(file.fd, range, () => {
      if (cut > 0) return
      // 받아 둔 끝(쓴 것 + 쓰기를 기다리는 것) 뒤, 소켓이 채우는 중인 슬랩 안에서 자른다
      cut = writer.written + writer.writableLength + 100 * KiB + 7
      writer.splitAt(cut)
    })

    const err = await downloadInto(client, writer, '/f', 0).catch((e: unknown) => e)
    await writer.stop()
    await file.close()

    expect((err as NodeJS.ErrnoException).code).toBe(SEGMENT_DONE)
    expect(writer.written).toBe(cut)
    const got = fs.readFileSync(path.join(dir, 'split.bin'))
    expect(got.subarray(0, cut).equals(data.subarray(0, cut))).toBe(true)
    expect(got.subarray(cut).equals(Buffer.alloc(data.length - cut))).toBe(true)
  })

  it('should not write after a cancelled download settles and should give its queued slabs back', async () => {
    const data = content(8 * MiB, 41)
    const client = await connect(data)
    let writes = 0
    let cancelAt = 0
    hooks.writev = (write) => {
      // 취소는 TransferQueue.cancel처럼 전송 중인 클라이언트를 닫는다
      if (++writes === cancelAt) client.close()
      setTimeout(write, 10)
    }
    // 느린 디스크로 풀을 한 번 채운다
    await ops.download('/f', path.join(dir, 'warm.bin'), undefined, client)

    cancelAt = writes + 3
    await expect(
      ops.download('/f', path.join(dir, 'cancel.bin'), undefined, client)
    ).rejects.toThrow()
    expect(writes).toBeGreaterThanOrEqual(cancelAt)
    const settled = writes
    await new Promise((r) => setTimeout(r, 150))
    expect(writes).toBe(settled)

    const alloc = vi.spyOn(Buffer, 'allocUnsafeSlow')
    const next = await login()
    const local = path.join(dir, 'next.bin')
    await ops.download('/f', local, undefined, next)

    expect(sha256(fs.readFileSync(local))).toBe(sha256(data))
    // 취소된 소켓이 쥐고 있던 슬랩 하나만 돌아오지 않는다
    expect(slabAllocations(alloc)).toBeLessThanOrEqual(1)
  })
})
