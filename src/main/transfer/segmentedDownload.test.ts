import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { once } from 'events'
import {
  planSegments,
  SegmentWriter,
  SEGMENT_MIN,
  SEGMENT_SIZE,
  SEGMENT_DONE,
  SEGMENT_OVERFLOW
} from './segmentedDownload'

const MiB = 1024 * 1024

describe('planSegments', () => {
  it('should return no ranges below the segmentation threshold', () => {
    expect(planSegments(63 * MiB, 10)).toEqual([])
    expect(planSegments(0, 10)).toEqual([])
  })

  it('should return no ranges when the pool cannot run two segments at once', () => {
    expect(planSegments(512 * MiB, 1)).toEqual([])
    expect(planSegments(512 * MiB, 0)).toEqual([])
  })

  it('should return no ranges when only one segment would result', () => {
    expect(planSegments(SEGMENT_MIN, 10)).toEqual([])
  })

  it('should split 512 MiB into 8 even ranges covering [0, size) exactly', () => {
    const size = 512 * MiB
    const ranges = planSegments(size, 10)
    expect(ranges).toHaveLength(8)
    expect(ranges[0].start).toBe(0)
    expect(ranges[ranges.length - 1].end).toBe(size)
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].start).toBe(ranges[i - 1].end)
    }
    for (const r of ranges) expect(r.end - r.start).toBe(64 * MiB)
  })

  it('should cap the range count at the limit', () => {
    const ranges = planSegments(512 * MiB, 3)
    expect(ranges).toHaveLength(3)
    expect(ranges[0].start).toBe(0)
    expect(ranges[2].end).toBe(512 * MiB)
  })

  it('should mark only the last range as final', () => {
    const ranges = planSegments(512 * MiB, 4)
    expect(ranges.map((r) => r.final)).toEqual([false, false, false, true])
  })

  it('should spread the remainder so no range is more than 1 byte larger than another', () => {
    const size = 200 * MiB + 7
    const ranges = planSegments(size, 3)
    const lens = ranges.map((r) => r.end - r.start)
    expect(lens.reduce((a, b) => a + b, 0)).toBe(size)
    expect(Math.max(...lens) - Math.min(...lens)).toBeLessThanOrEqual(1)
    expect(ranges[ranges.length - 1].end).toBe(size)
  })

  it('should honour lowered thresholds passed by tests', () => {
    const ranges = planSegments(5 * MiB, 4, 1 * MiB, 1 * MiB)
    expect(ranges).toHaveLength(4)
    expect(ranges[3].end).toBe(5 * MiB)
  })

  it('should derive the count from ceil(size / SEGMENT_SIZE)', () => {
    expect(planSegments(SEGMENT_SIZE + 1, 10, 1, SEGMENT_SIZE)).toHaveLength(2)
    expect(planSegments(SEGMENT_SIZE * 3, 10, 1, SEGMENT_SIZE)).toHaveLength(3)
  })
})

describe('SegmentWriter', () => {
  let dir: string
  let file: string
  let fd: number

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'segwriter-'))
    file = path.join(dir, 'out.bin')
    fd = fs.openSync(file, 'w')
    fs.ftruncateSync(fd, 100)
  })

  afterEach(() => {
    try {
      fs.closeSync(fd)
    } catch {
      // 이미 닫힌 fd.
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function readAll(): Buffer {
    return fs.readFileSync(file)
  }

  it('should write chunks at the range offset', async () => {
    const w = new SegmentWriter(fd, { start: 10, end: 30, final: true })
    w.write(Buffer.alloc(8, 1))
    w.write(Buffer.alloc(12, 2))
    w.end()
    await once(w, 'finish')

    const data = readAll()
    expect(data.subarray(0, 10).every((b) => b === 0)).toBe(true)
    expect(data.subarray(10, 18).every((b) => b === 1)).toBe(true)
    expect(data.subarray(18, 30).every((b) => b === 2)).toBe(true)
    expect(data.subarray(30).every((b) => b === 0)).toBe(true)
    expect(w.written).toBe(20)
    expect(w.overflow).toBe(false)
    expect(w.complete).toBe(true)
  })

  it('should trim the last chunk at len and signal SEGMENT_DONE for a non-final range', async () => {
    const w = new SegmentWriter(fd, { start: 0, end: 10, final: false })
    const errored = once(w, 'error')
    w.write(Buffer.alloc(6, 1))
    w.write(Buffer.alloc(10, 2))
    const [err] = await errored

    expect((err as NodeJS.ErrnoException).code).toBe(SEGMENT_DONE)
    expect(w.written).toBe(10)
    expect(w.complete).toBe(true)
    expect(w.overflow).toBe(false)

    const data = readAll()
    expect(data.subarray(0, 6).every((b) => b === 1)).toBe(true)
    expect(data.subarray(6, 10).every((b) => b === 2)).toBe(true)
    // 잘린 나머지 6바이트는 다음 세그먼트 영역이므로 건드리지 않는다.
    expect(data.subarray(10, 16).every((b) => b === 0)).toBe(true)
  })

  it('should stop when a chunk ends exactly at len', async () => {
    const w = new SegmentWriter(fd, { start: 0, end: 10, final: false })
    const errored = once(w, 'error')
    w.write(Buffer.alloc(10, 3))
    const [err] = await errored

    expect((err as NodeJS.ErrnoException).code).toBe(SEGMENT_DONE)
    expect(w.written).toBe(10)
    expect(
      readAll()
        .subarray(0, 10)
        .every((b) => b === 3)
    ).toBe(true)
  })

  it('should report overflow when the final range receives extra bytes', async () => {
    const w = new SegmentWriter(fd, { start: 90, end: 100, final: true })
    const errored = once(w, 'error')
    w.write(Buffer.alloc(6, 1))
    w.write(Buffer.alloc(10, 2))
    const [err] = await errored

    expect((err as NodeJS.ErrnoException).code).toBe(SEGMENT_OVERFLOW)
    expect(w.overflow).toBe(true)
    expect(w.written).toBe(10)
    // 파일 크기를 넘겨 쓰지 않는다.
    expect(readAll().length).toBe(100)
  })

  it('should not report overflow when the final range ends exactly at len', async () => {
    const w = new SegmentWriter(fd, { start: 90, end: 100, final: true })
    w.write(Buffer.alloc(10, 5))
    w.end()
    await once(w, 'finish')

    expect(w.overflow).toBe(false)
    expect(w.complete).toBe(true)
  })

  it('should leave a short final range incomplete', async () => {
    const w = new SegmentWriter(fd, { start: 90, end: 100, final: true })
    w.write(Buffer.alloc(4, 5))
    w.end()
    await once(w, 'finish')

    expect(w.written).toBe(4)
    expect(w.complete).toBe(false)
  })

  it('should report progress as the sum of bytes actually written', async () => {
    const seen: number[] = []
    const w = new SegmentWriter(fd, { start: 0, end: 10, final: false }, (n) => seen.push(n))
    const errored = once(w, 'error')
    w.write(Buffer.alloc(4, 1))
    w.write(Buffer.alloc(4, 1))
    w.write(Buffer.alloc(10, 1))
    await errored

    expect(seen.reduce((a, b) => a + b, 0)).toBe(10)
    expect(seen).toEqual([4, 4, 2])
  })

  it('should surface fd write errors', async () => {
    const closed = fs.openSync(path.join(dir, 'other.bin'), 'w')
    fs.closeSync(closed)
    const w = new SegmentWriter(closed, { start: 0, end: 10, final: true })
    const errored = once(w, 'error')
    w.write(Buffer.alloc(4, 1))
    const [err] = await errored

    expect((err as NodeJS.ErrnoException).code).toBe('EBADF')
  })

  it('should resolve stop() only after the in-flight write lands, and drop later chunks', async () => {
    const w = new SegmentWriter(fd, { start: 0, end: 50, final: true })
    w.write(Buffer.alloc(10, 1))
    await w.stop()

    // stop()이 resolve된 시점에는 fd를 닫아도 늦은 쓰기가 남지 않는다
    expect(w.written).toBe(10)
    expect(
      readAll()
        .subarray(0, 10)
        .every((b) => b === 1)
    ).toBe(true)

    const accepted = new Promise<void>((resolve) => w.write(Buffer.alloc(10, 2), () => resolve()))
    await accepted
    expect(w.written).toBe(10)
    expect(
      readAll()
        .subarray(10, 20)
        .every((b) => b === 0)
    ).toBe(true)
  })
})
