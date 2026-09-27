import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatLastConnected,
  parseServerAddress,
  resolveDraft,
  serverAddress,
  stripPassword,
  emptyDraft
} from './serverAddress'

describe('parseServerAddress', () => {
  it('keeps a bare host as is', () => {
    expect(parseServerAddress(' 192.168.0.10 ')).toEqual({ host: '192.168.0.10' })
  })

  it('splits host:port and user@host:port', () => {
    expect(parseServerAddress('nas.local:2121')).toEqual({ host: 'nas.local', port: 2121 })
    expect(parseServerAddress('pi@10.0.0.5:2221')).toEqual({
      host: '10.0.0.5',
      port: 2221,
      user: 'pi'
    })
  })

  it('splits a full URL with credentials, decoded path and FTPS', () => {
    expect(parseServerAddress('ftps://me:p%40ss@files.example.com:990/DCIM/Camera%20(1)/')).toEqual(
      {
        host: 'files.example.com',
        port: 990,
        user: 'me',
        password: 'p@ss',
        secure: true,
        path: '/DCIM/Camera (1)'
      }
    )
    expect(parseServerAddress('ftp://phone:21')).toEqual({ host: 'phone', port: 21 })
  })

  it('survives a stray % and IPv6 literals', () => {
    expect(parseServerAddress('bob:100%@nas:21')).toEqual({
      host: 'nas',
      port: 21,
      user: 'bob',
      password: '100%'
    })
    expect(parseServerAddress('[::1]:2121')).toEqual({ host: '::1', port: 2121 })
  })
})

describe('serverAddress', () => {
  it('hides anonymous users and brackets IPv6 hosts so the text parses back', () => {
    expect(serverAddress({ username: 'anonymous', host: 'nas', port: 21 })).toBe('nas:21')
    expect(serverAddress({ username: 'pi', host: '::1', port: 2121 })).toBe('pi@[::1]:2121')
    expect(parseServerAddress(serverAddress({ username: 'pi', host: '::1', port: 2121 }))).toEqual({
      host: '::1',
      port: 2121,
      user: 'pi'
    })
  })
})

describe('formatLastConnected', () => {
  afterEach(() => vi.useRealTimers())

  it('reads SQLite UTC timestamps as UTC and formats them relative to now', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'))
    expect(formatLastConnected('2026-09-27 09:30:00', 'en')).toBe('2 hours ago')
    expect(formatLastConnected('2026-09-26 12:00:00', 'en')).toBe('yesterday')
    expect(formatLastConnected('2026-09-27 11:59:30', 'en')).toBe('now')
    expect(formatLastConnected(undefined, 'en')).toBeNull()
  })
})

describe('stripPassword', () => {
  it('keeps everything but the password', () => {
    expect(stripPassword('ftps://me:p@ss@nas:990/DCIM')).toBe('ftps://me@nas:990/DCIM')
    expect(stripPassword('me:secret@nas')).toBe('me@nas')
    expect(stripPassword('me@nas:21')).toBe('me@nas:21')
    expect(stripPassword('nas:21/a@b')).toBe('nas:21/a@b')
    expect(stripPassword('me:pa#ss@nas.local')).toBe('me@nas.local')
    expect(stripPassword('me:@nas')).toBe('me@nas')
  })

  it('parses unencoded #, ?, / and @ in a password instead of turning it into the host', () => {
    expect(parseServerAddress('me:pa#ss@nas.local')).toEqual({
      host: 'nas.local',
      user: 'me',
      password: 'pa#ss'
    })
    expect(parseServerAddress('ftp://me:p/a?s@s@nas.local:2121/DCIM')).toEqual({
      host: 'nas.local',
      port: 2121,
      user: 'me',
      password: 'p/a?s@s',
      path: '/DCIM'
    })
    expect(parseServerAddress('nas:21/a@b')).toEqual({ host: 'nas', port: 21, path: '/a@b' })
  })
})

describe('resolveDraft', () => {
  it('keeps the typed case of a plain host and does not turn port 0 into 21', () => {
    const d = { ...emptyDraft(), host: 'NAS.local', port: '0' }
    expect(resolveDraft(d).server).toMatchObject({ host: 'NAS.local', port: 0 })
    expect(resolveDraft({ ...d, port: '' }).server.port).toBe(21)
    expect(resolveDraft({ ...d, host: 'ftp://u@NAS.local:2121' }).server).toMatchObject({
      host: 'nas.local',
      port: 2121,
      username: 'u'
    })
  })
})
