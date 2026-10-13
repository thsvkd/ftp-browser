import { describe, expect, it } from 'vitest'
import { connKey, connLabel, parseConnKey } from './connKey'

describe('connKey', () => {
  it('builds user@host:port and falls back to anonymous for an empty user', () => {
    // covers: Test-960
    expect(connKey('nas.local', 21, 'me')).toBe('me@nas.local:21')
    expect(connKey('nas.local', 21, '')).toBe('anonymous@nas.local:21')

    // 지금 Sidebar.tsx의 serverKey와 useFtpStore의 키가 만들던 문자열과 같아야 한다.
    const legacy = (host: string, port: number, user: string): string =>
      `${user || 'anonymous'}@${host}:${port}`
    const inputs: Array<[string, number, string]> = [
      ['nas.local', 21, 'me'],
      ['Example.COM', 2121, 'kim'],
      ['10.0.0.5', 990, '']
    ]
    for (const [host, port, user] of inputs) {
      expect(connKey(host, port, user)).toBe(legacy(host, port, user))
    }
  })
})

describe('parseConnKey', () => {
  it('splits on the last @ and the last colon', () => {
    // covers: Test-961
    expect(parseConnKey('a@b@h:2121')).toEqual({ user: 'a@b', host: 'h', port: 2121 })
    expect(parseConnKey('me@::1:21')).toEqual({ user: 'me', host: '::1', port: 21 })
  })

  it('returns null without an @ or with a port that is not 1-65535', () => {
    // covers: Test-961
    expect(parseConnKey('nas.local:21')).toBeNull()
    expect(parseConnKey('me@nas.local:abc')).toBeNull()
    expect(parseConnKey('me@nas.local:0')).toBeNull()
    expect(parseConnKey('me@nas.local:65536')).toBeNull()
  })

  it('round-trips with connKey', () => {
    // covers: Test-961
    for (const key of ['me@nas.local:21', 'a@b@h:2121', 'me@::1:21']) {
      const parsed = parseConnKey(key)
      expect(parsed).not.toBeNull()
      expect(connKey(parsed!.host, parsed!.port, parsed!.user)).toBe(key)
    }
  })
})

describe('connLabel', () => {
  it('shows the key itself, drops only an exact anonymous user, and passes non-keys through', () => {
    // covers: Test-1140
    const RA = 'ra@127.0.0.1:2121'
    expect(connLabel(RA)).toBe(RA)
    expect(connLabel('anonymous@ftp.example.com:21')).toBe('ftp.example.com:21')
    expect(connLabel('Anonymous@h:21')).toBe('Anonymous@h:21')
    expect(connLabel('a@b@h:21')).toBe('a@b@h:21')
    expect(connLabel('h:21')).toBe('h:21')
    expect(connLabel('')).toBe('')
  })
})
