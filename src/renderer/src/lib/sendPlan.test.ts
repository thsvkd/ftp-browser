import { describe, expect, it } from 'vitest'
import { planSend, type SendConnection } from './sendPlan'
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

const connected: SendConnection = {
  connected: true,
  server: 'me@h:21',
  isConnected: (server) => server === null || server === undefined || server === 'me@h:21'
}
const offline: SendConnection = { connected: false, server: null, isConnected: () => false }
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
    const copy = planSend([local('C:\\x\\a.jpg')], localDir('C:\\y'), offline)
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
    expect(planSend([local('C:\\x\\a.jpg')], remoteDir('/p'), offline).invalid).toBe(
      'send.invalidNotConnected'
    )
    expect(planSend([remote('/p/a.jpg')], localDir('C:\\dl'), offline).invalid).toBe(
      'send.invalidNotConnected'
    )
    expect(
      planSend([local('C:\\x\\a.jpg')], remoteDir('/p', 'other@h:21'), connected).invalid
    ).toBe('send.invalidOtherServer')
    expect(
      planSend([remote('/p/a.jpg', 'file', 'other@h:21')], localDir('C:\\dl'), connected).invalid
    ).toBe('send.invalidOtherServer')
    expect(planSend([remote('/p/a.jpg')], remoteDir('/q'), connected, { copy: true }).invalid).toBe(
      'send.invalidRemoteCopy'
    )
    expect(planSend([], localDir('C:\\dl'), connected).invalid).toBe('send.invalidNothing')
  })

  it('passes to any open destination session and refuses only closed ones', () => {
    // covers: Test-917
    const conn: SendConnection = {
      connected: true,
      server: 'alice@a:21',
      isConnected: (server) =>
        server === null || server === undefined || server === 'alice@a:21' || server === 'bob@b:21'
    }

    // primary가 아닌, 그러나 열려 있는 세션의 탭 → 전송 계획이 통과한다
    const up = planSend([local('C:\\x\\a.jpg')], remoteDir('/p', 'bob@b:21'), conn)
    expect(up).toMatchObject({ invalid: null, direction: 'upload' })
    const down = planSend([remote('/p/a.jpg', 'file', 'bob@b:21')], localDir('C:\\dl'), conn)
    expect(down).toMatchObject({ invalid: null, direction: 'download' })

    // 그 서버가 안 열렸을 때만 invalidOtherServer
    expect(planSend([local('C:\\x\\a.jpg')], remoteDir('/p', 'carol@c:21'), conn).invalid).toBe(
      'send.invalidOtherServer'
    )
    expect(
      planSend([remote('/p/a.jpg', 'file', 'carol@c:21')], localDir('C:\\dl'), conn).invalid
    ).toBe('send.invalidOtherServer')

    // 열린 세션이 하나도 없을 때만 invalidNotConnected
    const offline: SendConnection = { connected: false, server: null, isConnected: () => false }
    expect(planSend([local('C:\\x\\a.jpg')], remoteDir('/p'), offline).invalid).toBe(
      'send.invalidNotConnected'
    )
  })
})
