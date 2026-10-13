import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentError } from './agentOps'
import { resolveTarget } from './agentTarget'
import { addServer, createHarness, type Harness } from './__fixtures__/agentHarness'

const A = 'me@nas.local:21'
const B = 'kim@ftp.office.lan:2121'

let h: Harness

beforeEach(() => {
  h = createHarness()
})

afterEach(() => {
  h.db.close()
})

/** resolveTarget가 던진 AgentError(코드·문구) */
function failure(server?: number | string): AgentError {
  try {
    resolveTarget(h.deps, server)
  } catch (err) {
    if (err instanceof AgentError) return err
    throw err
  }
  throw new Error('resolveTarget did not fail')
}

describe('resolveTarget — the server argument (rule 1)', () => {
  it('picks a connection by its key, a saved id, alias or host, and names a saved server that is not connected', () => {
    // covers: Test-1002
    h.connections.add(B)
    const office = addServer(h.db, {
      name: 'Office',
      host: 'ftp.office.lan',
      port: 2121,
      user: 'kim'
    })
    const nas = addServer(h.db, { name: 'NAS', host: 'nas.local', user: 'me' })

    expect(resolveTarget(h.deps, 'KIM@FTP.Office.lan:2121')).toBe(B)
    expect(resolveTarget(h.deps, office)).toBe(B)
    expect(resolveTarget(h.deps, String(nas))).toBe(A)
    expect(resolveTarget(h.deps, 'office')).toBe(B)
    expect(resolveTarget(h.deps, 'NAS.local')).toBe(A)
    expect(resolveTarget(h.deps, 'ftp.office.lan:2121')).toBe(B)

    // 저장돼 있지만 연결 안 됨
    const media = addServer(h.db, { name: 'Media', host: 'media.lan', user: 'me' })
    const offline = failure('Media')
    expect(offline.code).toBe('NOT_CONNECTED')
    expect(offline.message).toContain('Media')
    expect(offline.message).toMatch(new RegExp(`Call connect with server ${media}`))

    // get_status가 보인 끊긴 연결의 키는 NOT_FOUND가 아니라 NOT_CONNECTED
    h.connections.add('me@media.lan:21').setOffline()
    const dropped = failure('ME@media.lan:21')
    expect(dropped.code).toBe('NOT_CONNECTED')
    expect(dropped.message).toBe(
      `me@media.lan:21 is not connected. Call connect with server ${media} first.`
    )
    h.connections.add('bob@unsaved.lan:21').setOffline()
    expect(failure('bob@unsaved.lan:21')).toMatchObject({
      code: 'NOT_CONNECTED',
      message:
        'bob@unsaved.lan:21 is not connected. It is not a saved server; connect to it in FTP Browser first.'
    })

    // 모르는 이름은 지금 NOT_FOUND 문구
    const missing = failure('nowhere')
    expect(missing.code).toBe('NOT_FOUND')
    expect(missing.message).toMatch(/^No saved server matches "nowhere"\. Saved servers: /)
  })
})

describe('resolveTarget — a saved server goes only to the connection of its own user', () => {
  it('names the keys of other users on that host:port instead of falling back to one of them', () => {
    // covers: Test-1198
    const backup = addServer(h.db, { name: 'Backup', host: 'backup.lan', user: 'admin' })
    h.connections.add('guest@backup.lan:21')
    h.deps.target.last = A

    const one = failure(backup)
    expect(one.code).toBe('NOT_CONNECTED')
    expect(one.message).toBe(
      `Backup (id ${backup}, backup.lan:21) is not connected as admin. Connected there as other ` +
        'users: guest@backup.lan:21. Call connect with server ' +
        `${backup} first, or pass server with one of those keys.`
    )
    expect(h.deps.target.last).toBe(A)

    h.connections.add('other@backup.lan:21')
    const two = failure(backup)
    expect(two.code).toBe('NOT_CONNECTED')
    expect(two.message).toBe(
      `Backup (id ${backup}, backup.lan:21) is not connected as admin. Connected there as other ` +
        'users: guest@backup.lan:21, other@backup.lan:21. Call connect with server ' +
        `${backup} first, or pass server with one of those keys.`
    )
    expect(h.deps.target.last).toBe(A)

    // 저장 행의 사용자가 연결되면 그것을 고른다
    h.connections.add('admin@backup.lan:21')
    expect(resolveTarget(h.deps, backup)).toBe('admin@backup.lan:21')
  })
})

describe('resolveTarget — the last used connection (rule 2)', () => {
  it('defaults to the connection the agent last connected or picked, while it stays connected', () => {
    // covers: Test-1003
    h.connections.add(B)
    addServer(h.db, { name: 'NAS', host: 'nas.local', user: 'me' })
    h.deps.target.last = B

    expect(resolveTarget(h.deps)).toBe(B)

    expect(resolveTarget(h.deps, 'NAS')).toBe(A)
    expect(resolveTarget(h.deps)).toBe(A)
    expect(h.deps.target.last).toBe(A)

    // 마지막 사용 연결이 끊기면 무시하고 규칙 3(연결 하나면 그것)으로
    h.remote.setOffline()
    expect(resolveTarget(h.deps)).toBe(B)
  })
})

describe('resolveTarget — no argument and no last connection (rules 3 and 4)', () => {
  it('uses the only connection, and fails with NOT_CONNECTED or AMBIGUOUS otherwise', () => {
    // covers: Test-1004
    expect(resolveTarget(h.deps)).toBe(A)

    h.remote.setOffline()
    const none = failure()
    expect(none.code).toBe('NOT_CONNECTED')
    expect(none.message).toBe('FTP Browser is not connected to an FTP server.')

    h.remote.connected = true
    h.remote.status = 'connected'
    h.connections.add(B)
    const id = addServer(h.db, { name: 'Office', host: 'ftp.office.lan', port: 2121, user: 'kim' })
    const both = failure()
    expect(both.code).toBe('AMBIGUOUS')
    expect(both.message).toBe(`2 servers are connected: ${A}, ${B} (Office, id ${id}).`)
  })
})

describe('resolveTarget — a disconnected key of another user on a saved address', () => {
  it('does not send the agent to the saved server of another user', () => {
    // covers: Test-1157
    const RA = 'ra@127.0.0.1:2121'
    const RB2 = 'rb2@127.0.0.1:2121'
    const id = addServer(h.db, { host: '127.0.0.1', port: 2121, user: 'ra' })
    h.connections.add(RA).setOffline()
    h.connections.add(RB2).setOffline()

    const rb2 = failure(RB2)
    expect(rb2.code).toBe('NOT_CONNECTED')
    expect(rb2.message).toBe(
      `${RB2} is not connected. It is not a saved server; connect to it in FTP Browser first.`
    )
    expect(rb2.message).not.toContain('Call connect with server')

    const ra = failure(RA)
    expect(ra.code).toBe('NOT_CONNECTED')
    expect(ra.message).toBe(`${RA} is not connected. Call connect with server ${id} first.`)
  })
})
