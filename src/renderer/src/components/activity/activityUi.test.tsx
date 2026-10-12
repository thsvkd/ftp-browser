/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { TransferJob } from '@shared/types/transfer'
import { BatchIcon, ProgressBar } from './activityUi'

function job(over: Partial<TransferJob> = {}): TransferJob {
  return {
    id: 'a',
    server: 'me@nas.local:21',
    direction: 'upload',
    localPath: 'C:\\in\\a',
    remotePath: '/photos/a',
    fileName: 'a',
    totalBytes: 100,
    transferredBytes: 0,
    status: 'active',
    ...over
  }
}

afterEach(cleanup)

function icon(jobs: TransferJob[]): SVGElement {
  const { container } = render(<BatchIcon jobs={jobs} />)
  const svg = container.querySelector('svg')
  if (!svg) throw new Error('no icon')
  return svg
}

describe('activityUi', () => {
  it('draws the direction while running and a check, alert or slash once finished', () => {
    // covers: Test-1106
    const up = icon([job()])
    expect(up.dataset.status).toBe('running')
    expect(up.classList.contains('lucide-arrow-up-from-line')).toBe(true)
    expect(up.getAttribute('aria-hidden')).toBe('true')
    expect(icon([job({ direction: 'download' })]).classList).toContain('lucide-arrow-down-to-line')
    expect(icon([job({ status: 'completed' })]).classList).toContain('lucide-circle-check')
    expect(icon([job({ status: 'failed' })]).classList).toContain('lucide-circle-alert')
    expect(icon([job({ status: 'cancelled' })]).classList).toContain('lucide-circle-slash')

    const { getByRole } = render(<ProgressBar label="photos progress" value={40} />)
    const bar = getByRole('progressbar', { name: 'photos progress' })
    expect(bar.getAttribute('aria-valuenow')).toBe('40')
  })
})
