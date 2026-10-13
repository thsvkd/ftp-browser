import { beforeEach, describe, expect, it } from 'vitest'
import { batchProgress, formatDuration, nextRate, remainingSeconds } from './transferRate'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import type { TransferJob } from '@shared/types/transfer'

beforeEach(() => {
  useSettingsStore.setState({ language: 'en' })
})

function job(over: Partial<TransferJob>): TransferJob {
  return {
    id: 'j',
    server: 'me@nas.local:21',
    direction: 'download',
    localPath: 'C:\\a',
    remotePath: '/a',
    fileName: 'a',
    totalBytes: 100,
    transferredBytes: 0,
    status: 'pending',
    ...over
  }
}

describe('transferRate', () => {
  it('smooths speed from samples, finds no ETA at 0 B/s, caps batch progress and formats time', () => {
    // covers: Test-777
    const first = nextRate(undefined, 0, 1_000)
    expect(first.rate).toBe(0)
    // Two samples give the first rate as is.
    const second = nextRate(first, 1_000, 2_000)
    expect(second.rate).toBe(1_000)
    // Then exponential smoothing (alpha 0.3) toward the new instant rate.
    const third = nextRate(second, 4_000, 3_000)
    expect(third.rate).toBeCloseTo(0.3 * 3_000 + 0.7 * 1_000)
    // A sample at the same instant is ignored.
    expect(nextRate(third, 9_000, 3_000)).toBe(third)

    expect(remainingSeconds(1_000, 0)).toBeNull()
    expect(remainingSeconds(1_000, 250)).toBe(4)

    // All bytes sent but not completed yet: 99%, never 100% before 226.
    expect(
      batchProgress([
        job({ status: 'completed', transferredBytes: 100 }),
        job({ status: 'active', transferredBytes: 100 })
      ])
    ).toEqual({ percent: 99, done: 1, total: 2, transferredBytes: 200, totalBytes: 200 })
    expect(
      batchProgress([
        job({ status: 'completed', transferredBytes: 100 }),
        job({ status: 'completed', transferredBytes: 40 })
      ]).percent
    ).toBe(100)
    expect(batchProgress([job({ status: 'active', transferredBytes: 25 })]).percent).toBe(25)
    // Zero-byte files count by file.
    expect(
      batchProgress([
        job({ totalBytes: 0, status: 'completed' }),
        job({ totalBytes: 0, status: 'pending' })
      ]).percent
    ).toBe(50)

    expect(formatDuration(45)).toBe('45 s')
    expect(formatDuration(130)).toBe('2 min')
    expect(formatDuration(2 * 3600 + 100)).toBe('2 h')
  })
})
