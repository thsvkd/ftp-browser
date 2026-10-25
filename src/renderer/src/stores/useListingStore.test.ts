import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useListingStore } from './useListingStore'
import { locKey, type Loc } from '@renderer/lib/explorerEntry'
import type { FtpFileEntry } from '@shared/types/ftp'
import type { LocalFileEntry } from '@shared/types/local'

function ftp(name: string): FtpFileEntry {
  return { name, type: 'file', size: 1, modifiedAt: '', rawModifiedAt: '', isImage: false }
}

function local(dir: string, name: string): LocalFileEntry {
  return { name, path: `${dir}\\${name}`, type: 'file', size: 1, modifiedAt: '', isImage: false }
}

interface Deferred {
  resolve: (value: unknown) => void
}

const invoke = vi.fn()
let pending: Array<{ channel: string; path: string } & Deferred> = []

beforeEach(() => {
  pending = []
  invoke.mockReset()
  invoke.mockImplementation(
    (channel: string, path: string) =>
      new Promise((resolve) => pending.push({ channel, path, resolve }))
  )
  vi.stubGlobal('window', { api: { invoke } })
  useListingStore.setState({ byKey: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const remoteDir: Loc = { side: 'remote', server: 'me@h:21', path: '/p' }
const localDir: Loc = { side: 'local', path: 'C:\\x' }
const get = (loc: Loc): ReturnType<typeof useListingStore.getState>['byKey'][string] =>
  useListingStore.getState().byKey[locKey(loc)]

describe('useListingStore', () => {
  it('lists per key, keeps the old list while refreshing, drops stale results, invalidates one folder, stores error codes', async () => {
    // covers: Test-787
    const { load, invalidate } = useListingStore.getState()

    // First load: loading, then ready with ExplorerEntries of that key.
    const first = load(remoteDir)
    expect(get(remoteDir)).toMatchObject({ status: 'loading', entries: [], refreshing: false })
    expect(pending[0]).toMatchObject({ channel: 'ftp:list', path: '/p' })
    pending[0].resolve({ success: true, data: { path: '/p', entries: [ftp('a')] } })
    await first
    expect(get(remoteDir)).toMatchObject({ status: 'ready', refreshing: false })
    expect(get(remoteDir).entries[0]).toMatchObject({
      side: 'remote',
      server: 'me@h:21',
      path: '/p/a'
    })

    // Reload: old entries stay, refreshing on.
    const slow = load(remoteDir)
    expect(get(remoteDir)).toMatchObject({ status: 'ready', refreshing: true })
    expect(get(remoteDir).entries.map((e) => e.name)).toEqual(['a'])
    // A newer load wins even if the older one answers last.
    const fast = load(remoteDir)
    pending[2].resolve({ success: true, data: { path: '/p', entries: [ftp('new')] } })
    await fast
    pending[1].resolve({ success: true, data: { path: '/p', entries: [ftp('stale')] } })
    await slow
    expect(get(remoteDir).entries.map((e) => e.name)).toEqual(['new'])
    expect(get(remoteDir).refreshing).toBe(false)

    // Local listing.
    const l = load(localDir)
    pending[3].resolve({ success: true, data: { path: 'C:\\x', entries: [local('C:\\x', 'f')] } })
    await l
    expect(pending[3].channel).toBe('local:list')
    expect(get(localDir).entries[0]).toMatchObject({ side: 'local', path: 'C:\\x\\f' })

    // invalidate re-reads only that folder (and nothing that is not cached).
    invoke.mockClear()
    invalidate('local', undefined, 'C:\\x')
    invalidate('local', undefined, 'C:\\never-opened')
    expect(invoke.mock.calls).toEqual([['local:list', 'C:\\x']])
    pending[4].resolve({ success: true, data: { path: 'C:\\x', entries: [] } })

    // Failure keeps the code.
    const bad = load({ side: 'remote', server: 'me@h:21', path: '/locked' })
    pending[5].resolve({
      success: false,
      error: 'Permission denied',
      code: 'FTP_PERMISSION_DENIED'
    })
    await bad
    expect(get({ side: 'remote', server: 'me@h:21', path: '/locked' })).toMatchObject({
      status: 'error',
      refreshing: false,
      error: 'Permission denied',
      code: 'FTP_PERMISSION_DENIED'
    })
  })

  it('sends the tab session key with the remote listing so a non-primary tab never reads the primary list', async () => {
    // covers: Test-932
    const { load } = useListingStore.getState()
    const other: Loc = { side: 'remote', server: 'other@h2:21', path: '/p' }

    const listing = load(other)

    expect(invoke).toHaveBeenCalledWith('ftp:list', '/p', 'other@h2:21')
    pending[0].resolve({ success: true, data: { path: '/p', entries: [ftp('a')] } })
    await listing
    expect(get(other)).toMatchObject({ status: 'ready' })
    expect(get(other).entries[0]).toMatchObject({ server: 'other@h2:21' })
  })
})
