import { describe, expect, it } from 'vitest'
import { planSend } from './sendPlan'
import { planVerb } from './sendItems'
import { t } from '@renderer/i18n'
import type { ExplorerEntry, Loc } from './explorerEntry'

function remote(
  path: string,
  type: ExplorerEntry['type'] = 'file',
  server = 'me@h:21'
): ExplorerEntry {
  return {
    side: 'remote',
    server,
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    type,
    size: 1,
    modifiedAt: '',
    hidden: false,
    category: 'other',
    isImage: false
  }
}

function local(path: string, type: ExplorerEntry['type'] = 'file'): ExplorerEntry {
  return {
    side: 'local',
    path,
    name: path.slice(path.lastIndexOf('\\') + 1),
    type,
    size: 1,
    modifiedAt: '',
    hidden: false,
    category: 'other',
    isImage: false
  }
}

const connected: ReadonlySet<string> = new Set(['me@h:21'])
const none: ReadonlySet<string> = new Set()
const remoteDir = (path: string, server = 'me@h:21'): Loc => ({ side: 'remote', path, server })
const localDir = (path: string): Loc => ({ side: 'local', path })

describe('planSend', () => {
  it('plans downloads, uploads, moves, copies and refuses invalid sends', () => {
    // covers: Test-774
    const dl = planSend(
      [remote('/p/a.jpg'), remote('/p/dir', 'directory')],
      localDir('C:\\dl'),
      connected
    )
    expect(dl).toMatchObject({ direction: 'download', invalid: null, sameSideVerb: null, here: 0 })
    expect(dl.transfer.map((e) => e.path)).toEqual(['/p/a.jpg', '/p/dir'])

    const up = planSend([local('C:\\x\\a.jpg')], remoteDir('/p'), connected)
    expect(up).toMatchObject({ direction: 'upload', invalid: null })
    expect(up.transfer).toHaveLength(1)

    const move = planSend([remote('/p/a.jpg')], remoteDir('/q'), connected)
    expect(move).toMatchObject({ direction: null, sameSideVerb: 'move', invalid: null })
    expect(move.sameSide).toHaveLength(1)

    // Local copy needs no connection.
    const copy = planSend([local('C:\\x\\a.jpg')], localDir('C:\\y'), none)
    expect(copy).toMatchObject({ direction: null, sameSideVerb: 'copy', invalid: null })

    // Mixed: one already here, one moved, one downloaded.
    const mixed = planSend(
      [local('C:\\y\\here.jpg'), local('C:\\x\\b.jpg'), remote('/p/c.jpg')],
      localDir('C:\\y'),
      connected
    )
    expect(mixed).toMatchObject({ here: 1, direction: 'download', sameSideVerb: 'copy' })

    expect(planSend([local('C:\\y\\a.jpg')], localDir('C:\\y'), connected)).toMatchObject({
      invalid: 'send.invalidHere',
      here: 1
    })
    expect(
      planSend([remote('/p/dir', 'directory')], remoteDir('/p/dir/sub'), connected).invalid
    ).toBe('send.invalidIntoItself')
    expect(planSend([remote('/p/dir', 'directory')], remoteDir('/p/dir'), connected).invalid).toBe(
      'send.invalidIntoItself'
    )
    // A sibling whose name starts the same is not "inside".
    expect(planSend([remote('/p/dir', 'directory')], remoteDir('/p/dir2'), connected).invalid).toBe(
      null
    )
    expect(planSend([local('C:\\x\\a.jpg')], remoteDir('/p'), none).invalid).toBe(
      'send.invalidNotConnected'
    )
    expect(planSend([remote('/p/a.jpg')], localDir('C:\\dl'), none).invalid).toBe(
      'send.invalidNotConnected'
    )
    expect(planSend([remote('/p/a.jpg')], remoteDir('/q'), connected, { copy: true }).invalid).toBe(
      'send.invalidRemoteCopy'
    )
    expect(planSend([], localDir('C:\\dl'), connected).invalid).toBe('send.invalidNothing')
  })

  it('copies remote items to another server as a relay and keeps same-server rules', () => {
    // covers: Test-1016
    const A = 'me@h:21'
    const B = 'you@other:2121'
    const both: ReadonlySet<string> = new Set([A, B])

    const relay = planSend([remote('/p/a.jpg', 'file', A)], remoteDir('/q', B), both)
    expect(relay).toMatchObject({ direction: null, sameSideVerb: null, invalid: null, here: 0 })
    expect(relay.relay.map((e) => e.path)).toEqual(['/p/a.jpg'])
    expect(planVerb(relay)).toBe(t('send.copy', { count: 1 }))

    const move = planSend([remote('/p/a.jpg', 'file', A)], remoteDir('/q', A), both)
    expect(move).toMatchObject({ sameSideVerb: 'move', invalid: null, relay: [] })

    const down = planSend(
      [remote('/p/a.jpg', 'file', A), remote('/p/b.jpg', 'file', B)],
      localDir('C:\\dl'),
      both
    )
    expect(down).toMatchObject({ direction: 'download', invalid: null, relay: [] })
    expect(down.transfer.map((e) => e.server)).toEqual([A, B])

    const mixed = planSend(
      [local('C:\\x\\a.jpg'), remote('/p/b.jpg', 'file', A)],
      remoteDir('/q', B),
      both
    )
    expect(mixed).toMatchObject({ direction: 'upload', invalid: null })
    expect(mixed.transfer.map((e) => e.path)).toEqual(['C:\\x\\a.jpg'])
    expect(mixed.relay.map((e) => e.path)).toEqual(['/p/b.jpg'])

    // 서버가 다르면 "자기 안으로"도 "이미 여기"도 아니다
    expect(planSend([remote('/a', 'directory', A)], remoteDir('/a/b', B), both).invalid).toBe(null)
    const sameParent = planSend([remote('/a/x', 'file', A)], remoteDir('/a', B), both)
    expect(sameParent).toMatchObject({ here: 0, invalid: null })
    expect(sameParent.relay).toHaveLength(1)
    expect(planSend([remote('/a/x', 'file', A)], remoteDir('/a', A), both)).toMatchObject({
      here: 1,
      invalid: 'send.invalidHere'
    })

    // 관련 서버가 하나라도 연결 안 됨이면 막는다
    const onlyA: ReadonlySet<string> = new Set([A])
    expect(planSend([remote('/p/a.jpg', 'file', A)], remoteDir('/q', B), onlyA).invalid).toBe(
      'send.invalidNotConnected'
    )
    expect(planSend([remote('/p/a.jpg', 'file', B)], remoteDir('/q', A), onlyA).invalid).toBe(
      'send.invalidNotConnected'
    )
    // invalidOtherServer는 없다
    const all = [relay, move, down, mixed, sameParent].map((p) => p.invalid as string | null)
    expect(all).not.toContain('send.invalidOtherServer')
  })
})
