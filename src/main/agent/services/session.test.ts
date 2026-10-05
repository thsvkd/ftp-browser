import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createAgentServices } from './index'
import { createHarness, type Harness } from './__fixtures__/fakes'
import { AgentError, type AgentServices } from '../types'

let h: Harness
let services: AgentServices

function addServer(
  fields: Partial<{ name: string; host: string; port: number; user: string; password: string }>
): number {
  const s = { name: '', host: 'nas.local', port: 21, user: 'me', password: 'pw', ...fields }
  return Number(
    h.db
      .prepare(
        'INSERT INTO servers (name, host, port, username, password_enc, secure) VALUES (?, ?, ?, ?, ?, 0)'
      )
      .run(s.name, s.host, s.port, s.user, s.password).lastInsertRowid
  )
}

function addRecentPath(host: string, port: number, path: string, lastVisited: string): void {
  h.db
    .prepare(
      'INSERT INTO server_recent_paths (server_host, server_port, path, last_visited) VALUES (?, ?, ?, ?)'
    )
    .run(host, port, path, lastVisited)
}

beforeEach(() => {
  h = createHarness()
  h.remote.connected = false
  h.remote.status = 'disconnected'
  services = createAgentServices(h.deps)
})

afterEach(() => h.db.close())

describe('servers', () => {
  it('lists saved servers without any password key or value', () => {
    // covers: Test-400
    addServer({ name: 'NAS', password: 'hunter2-secret' })
    addServer({ host: 'ftp.example.com', password: 'other-secret' })

    const list = services.servers.list()

    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ host: expect.any(String), user: 'me', port: 21 })
    const json = JSON.stringify(list)
    expect(json).not.toMatch(/password/i)
    expect(json).not.toContain('hunter2-secret')
    expect(json).not.toContain('other-secret')
  })

  it('resolves by id, alias or host ignoring case, and names the saved servers when nothing matches', () => {
    // covers: Test-401
    const nas = addServer({ name: 'Home NAS', host: 'NAS.local' })
    const web = addServer({ host: 'ftp.example.com', port: 2121 })

    expect(services.servers.resolve(nas).id).toBe(nas)
    expect(services.servers.resolve('home nas').id).toBe(nas)
    expect(services.servers.resolve('nas.LOCAL').id).toBe(nas)
    expect(services.servers.resolve('FTP.example.com').id).toBe(web)
    expect(services.servers.resolve(String(web)).id).toBe(web)

    let error: unknown
    try {
      services.servers.resolve('missing')
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(AgentError)
    expect(error).toMatchObject({ code: 'NOT_FOUND' })
    expect((error as Error).message).toContain('Home NAS')
    expect((error as Error).message).toContain('ftp.example.com')
    expect(() => services.servers.resolve(999)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
  })

  it('removes a saved server with its recent paths', () => {
    // covers: Test-415
    const nas = addServer({ host: 'nas.local' })
    const other = addServer({ host: 'other.local' })
    addRecentPath('nas.local', 21, '/photos', '2026-01-01 00:00:00.000')
    addRecentPath('other.local', 21, '/keep', '2026-01-01 00:00:00.000')

    services.servers.remove(nas)

    expect(services.servers.list().map((s) => s.id)).toEqual([other])
    const paths = h.db.prepare('SELECT path FROM server_recent_paths').all()
    expect(paths).toEqual([{ path: '/keep' }])
    expect(() => services.servers.remove(nas)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
  })
})

describe('session.connect', () => {
  it('opens the last visited folder, falls back to / and tells the GUI', async () => {
    // covers: Test-402
    const id = addServer({ name: 'NAS', host: 'nas.local', user: 'me', password: 'pw' })
    addRecentPath('nas.local', 21, '/old', '2026-01-01 00:00:00.000')
    addRecentPath('NAS.local', 21, '/photos', '2026-01-02 00:00:00.000')
    h.remote.addDir('/photos')

    const result = await services.session.connect('nas')

    expect(result).toEqual({ path: '/photos' })
    expect(h.remote.connect).toHaveBeenCalledWith(
      expect.objectContaining({ id, host: 'nas.local', port: 21, user: 'me', password: 'pw' })
    )
    expect(h.events.session).toHaveBeenCalledWith({
      status: 'connected',
      serverId: id,
      host: 'nas.local',
      port: 21,
      user: 'me',
      path: '/photos'
    })
    expect(services.session.info()).toMatchObject({ status: 'connected', serverId: id })

    // 마지막 폴더가 사라졌으면 루트에서 연다
    h.remote.nodes.delete('/photos')
    h.events.session.mockClear()
    expect(await services.session.connect(id)).toEqual({ path: '/' })
    expect(h.events.session).toHaveBeenCalledWith(expect.objectContaining({ path: '/' }))

    await services.session.disconnect()
    expect(h.events.session).toHaveBeenLastCalledWith({ status: 'disconnected' })
  })

  it('refuses with BUSY while a transfer or a file operation is running', async () => {
    // covers: Test-403
    const id = addServer({})
    const job = h.queue.add({ status: 'active' })

    await expect(services.session.connect(id)).rejects.toMatchObject({ code: 'BUSY' })

    h.queue.finish(job.id, 'completed')
    const op = h.operations.create('delete', { itemCount: 1 }, 'files', 1)
    await expect(services.session.connect(id)).rejects.toMatchObject({ code: 'BUSY' })
    expect(h.remote.connect).not.toHaveBeenCalled()

    h.operations.complete(op.id)
    await expect(services.session.connect(id)).resolves.toEqual({ path: '/' })
  })
})

describe('session.key', () => {
  it('stays the same within a session and changes on every connect and disconnect', async () => {
    // covers: Test-609
    const id = addServer({})
    expect(services.session.key()).toBeUndefined()

    await services.session.connect(id)
    const first = services.session.key()
    expect(first).toEqual(expect.any(String))
    expect(services.session.key()).toBe(first)
    await services.session.connect(id)
    const second = services.session.key()
    await services.session.disconnect()

    expect(second).toEqual(expect.any(String))
    expect(second).not.toBe(first)
    expect(services.session.key()).toBeUndefined()
  })
})
