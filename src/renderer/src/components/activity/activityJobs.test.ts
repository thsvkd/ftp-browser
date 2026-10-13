import { beforeEach, describe, expect, it } from 'vitest'
import { t } from '@renderer/i18n'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import type { TransferJob } from '@shared/types/transfer'
import { batchIconState, locText, statusKey } from './activityJobs'

beforeEach(() => {
  useSettingsStore.setState({ language: 'en' })
})

function job(id: string, over: Partial<TransferJob> = {}): TransferJob {
  return {
    id,
    server: 'me@nas.local:21',
    direction: 'upload',
    localPath: `C:\\in\\${id}`,
    remotePath: `/photos/${id}`,
    fileName: id,
    totalBytes: 100,
    transferredBytes: 0,
    status: 'pending',
    ...over
  }
}

describe('activityJobs shared helpers', () => {
  it('writes the destination as source › path, or the path alone without a server', () => {
    // covers: Test-1103
    expect(locText({ side: 'local', path: 'C:\\dl' }, t)).toBe('This PC › C:\\dl')
    expect(locText({ side: 'remote', path: '/photos', server: 'me@nas:21' }, t)).toBe(
      'me@nas:21 › /photos'
    )
    expect(locText({ side: 'remote', path: '/photos' }, t)).toBe('/photos')
  })

  it('picks the status key: finishing once only the 226 is left, else the group status', () => {
    // covers: Test-1104
    expect(statusKey([job('a', { status: 'active', transferredBytes: 100 })])).toBe('job.finishing')
    expect(
      statusKey([
        job('a', { status: 'active', transferredBytes: 100 }),
        job('b', { status: 'pending' })
      ])
    ).toBe('job.active')
    expect(statusKey([job('a', { status: 'pending' })])).toBe('job.pending')
    expect(statusKey([job('a', { status: 'completed' }), job('b', { status: 'failed' })])).toBe(
      'job.failed'
    )
    expect(statusKey([job('a', { status: 'completed' })])).toBe('job.completed')
  })

  it('maps a batch to running, completed, failed or cancelled for its icon', () => {
    // covers: Test-1105
    expect(batchIconState([job('a', { status: 'pending' })])).toBe('running')
    expect(batchIconState([job('a', { status: 'active' }), job('b', { status: 'failed' })])).toBe(
      'running'
    )
    expect(batchIconState([job('a', { status: 'completed' })])).toBe('completed')
    expect(
      batchIconState([job('a', { status: 'completed' }), job('b', { status: 'cancelled' })])
    ).toBe('cancelled')
    expect(
      batchIconState([job('a', { status: 'cancelled' }), job('b', { status: 'failed' })])
    ).toBe('failed')
  })
})
