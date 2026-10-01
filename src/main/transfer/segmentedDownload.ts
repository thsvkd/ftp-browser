import type { SegmentRange } from '../ftp/segmentWriter'

// 구간 쓰기는 ftp/segmentWriter에 있다. 기존 가져오기가 그대로 되도록 여기서도 내보낸다.
export {
  SegmentWriter,
  downloadInto,
  SEGMENT_DONE,
  SEGMENT_OVERFLOW,
  type SegmentRange
} from '../ftp/segmentWriter'

/** 이 크기(64 MiB) 이상인 다운로드만 구간 분할 대상으로 삼는다. 테스트는 planSegments 인자로 낮춘다. */
export const SEGMENT_MIN = 64 * 1024 * 1024
/** 세그먼트 하나가 맡는 목표 크기. 구간 수는 ceil(size / SEGMENT_SIZE)를 풀 한도로 자른 값이다. */
export const SEGMENT_SIZE = 64 * 1024 * 1024

/**
 * SIZE 응답이 이보다 빠르면 LAN으로 보고 분할 대상 파일을 한 스트림으로 받기 시작한다. 루프백 왕복은 0.1 ms
 * 안팎, 유선 LAN은 0.1~0.5 ms에 서버 stat 시간이 더해지고, 현실적인 WAN은 3 ms 이상이다. 이벤트 루프가 바빠
 * LAN을 WAN으로 잘못 보면 원래의 분할 경로가 될 뿐이다.
 */
export const LAN_RTT_MS = 2
/** LAN 한 스트림의 속도를 첫 쓰기 완료부터 이만큼 잰 뒤 판정한다. 그 전에 끝나는 파일은 판정 없이 끝난다. */
export const PROBE_MS = 100
/**
 * LAN 한 스트림이 이보다 느리면(1GbE 유효 대역폭 근처) 연결당 속도 제한이나 스트림당 CPU 한계로 보고 남은
 * 부분을 구간으로 나눈다. 이보다 빠르면 FileZilla처럼 파일 하나를 한 연결로 받는 편이 빠르다(구간으로 나눠
 * 쓴 파일은 APFS에서 닫을 때 약 70 ms가 더 든다).
 */
export const FAST_STREAM_BPS = 100e6
/**
 * LAN 한 스트림의 쓰기 버퍼. 디스크 쓰기가 소켓 수신보다 느린 순간에도 수신이 멈추지 않게 크게 잡는다.
 * 평문 FTP는 슬랩(DOWNLOAD_SLAB x DOWNLOAD_SLABS)에 받아 슬랩 수가 메모리를 묶으므로 TLS 스트림 경로에서만 쓰인다.
 */
export const LAN_WRITE_BUFFER = 32 * 1024 * 1024

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
