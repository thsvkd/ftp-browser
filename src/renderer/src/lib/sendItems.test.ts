/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useTransferStore, type ConflictAnswer } from '@renderer/stores/useTransferStore'
import { sendItems } from './sendItems'
import type { ExplorerEntry, Loc } from './explorerEntry'
import type { LocalFileEntry } from '@shared/types/local'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

const mockInvoke = vi.fn()

function localFile(path: string): ExplorerEntry {
  return {
    side: 'local',
    path,
    name: path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1),
    type: 'file',
    size: 1024,
    modifiedAt: '2024-05-01T10:00:00.000Z',
    hidden: false,
    category: 'image',
    isImage: true
  }
}

function existingLocal(name: string): LocalFileEntry {
  return {
    path: `C:\\dst\\${name}`,
    name,
    type: 'file',
    size: 1,
    modifiedAt: '2024-04-01T10:00:00.000Z',
    isImage: true
  }
}

/** 충돌 시트를 스토브로: `askConflicts`가 주어진 답을 돌려주게 한다. */
function stubConflicts(answer: ConflictAnswer): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => answer)
  useTransferStore.setState({ askConflicts: mock })
  return mock
}

let originalAskConflicts: ReturnType<typeof useTransferStore.getState>['askConflicts']

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('api', makeApiMock(mockInvoke))
  originalAskConflicts = useTransferStore.getState().askConflicts
  useFtpStore.setState({ connectionStatus: 'disconnected', host: '', port: 21, username: '' })
})

afterEach(() => {
  useTransferStore.setState({ askConflicts: originalAskConflicts })
  vi.unstubAllGlobals()
})

describe('sendItems local same-side', () => {
  const dest: Loc = { side: 'local', path: 'C:\\dst' }

  it('deletes exactly the copied ops sources via local:deleteBatch after a successful copy when move was chosen', async () => {
    // covers: Test-868
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'local:list')
        return { success: true, data: { path: 'C:\\dst', entries: [existingLocal('a.jpg')] } }
      return { success: true }
    })
    stubConflicts({ decisions: { 'C:\\dst\\a.jpg': 'overwrite' }, verb: 'move' })

    const ok = await sendItems([localFile('C:\\src\\a.jpg')], dest)

    expect(ok).toBe(true)
    expect(invokeCalls(mockInvoke, 'local:copyFiles')).toHaveLength(1)
    expect(invokeCalls(mockInvoke, 'local:deleteBatch')).toEqual([[['C:\\src\\a.jpg']]])
  })

  it('never calls a delete channel for the default copy without conflicts', async () => {
    // covers: Test-869
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'local:list') return { success: true, data: { path: 'C:\\dst', entries: [] } }
      return { success: true }
    })

    const ok = await sendItems([localFile('C:\\src\\a.jpg')], dest)

    expect(ok).toBe(true)
    expect(invokeCalls(mockInvoke, 'local:copyFiles')).toHaveLength(1)
    expect(invokeCalls(mockInvoke, 'local:deleteBatch')).toEqual([])
  })

  it('deletes nothing when local:copyFiles failed although move was chosen', async () => {
    // covers: Test-870
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'local:list')
        return { success: true, data: { path: 'C:\\dst', entries: [existingLocal('a.jpg')] } }
      if (channel === 'local:copyFiles') return { success: false, error: 'disk full' }
      return { success: true }
    })
    stubConflicts({ decisions: { 'C:\\dst\\a.jpg': 'overwrite' }, verb: 'move' })

    const ok = await sendItems([localFile('C:\\src\\a.jpg')], dest)

    expect(ok).toBe(false)
    expect(invokeCalls(mockInvoke, 'local:deleteBatch')).toEqual([])
  })
})

describe('sendItems remote same-side', () => {
  it('calls ftp:rename only regardless of the verb, never a delete channel', async () => {
    // covers: Test-871
    useFtpStore.setState({ connectionStatus: 'connected', host: 'h', port: 21, username: 'me' })
    const dest: Loc = { side: 'remote', path: '/dst', server: 'me@h:21' }
    const item: ExplorerEntry = {
      side: 'remote',
      server: 'me@h:21',
      path: '/src/a.jpg',
      name: 'a.jpg',
      type: 'file',
      size: 1024,
      modifiedAt: '2024-05-01T10:00:00.000Z',
      hidden: false,
      category: 'image',
      isImage: true
    }
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'ftp:list') return { success: true, data: { path: '/dst', entries: [] } }
      return { success: true }
    })

    const ok = await sendItems([item], dest)

    expect(ok).toBe(true)
    expect(invokeCalls(mockInvoke, 'ftp:rename')).toEqual([['/src/a.jpg', '/dst/a.jpg', 'me@h:21']])
    expect(invokeCalls(mockInvoke, 'ftp:deleteBatch')).toEqual([])
    expect(invokeCalls(mockInvoke, 'local:deleteBatch')).toEqual([])
  })
})
