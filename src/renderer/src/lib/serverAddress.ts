import type { FtpServer } from '@shared/types/ftp'

export interface ParsedServerAddress {
  host: string
  port?: number
  user?: string
  password?: string
  secure?: boolean
  path?: string
}

/** A stray '%' (e.g. in a password) is legal to type but not valid percent-encoding. */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** A host (or bracketed IPv6) with an optional port, ending the authority. */
const HOST_AUTHORITY = /^(\[[^\]\s]+\]|[^\s/:@?#[\]]+)(:\d{1,5})?(?=[/?#]|$)/

interface Userinfo {
  scheme: string
  user: string
  password?: string
  /** Everything after the `@`: host, port and path. */
  rest: string
}

/**
 * Split `user:password@` off the address ourselves: `URL` gives up on an unencoded `#`, `?`
 * or `/` in a password, and the whole text would become the host. The `@` that ends the
 * userinfo is the first one followed by a plain host[:port], so a password may contain `@`
 * and a path may too. `nas/a@b` and `nas:21/a@b` are paths, not credentials.
 */
function splitUserinfo(text: string): Userinfo | null {
  const scheme = /^[a-z]+:\/\//i.exec(text)?.[0] ?? ''
  const body = text.slice(scheme.length)
  for (let at = body.indexOf('@'); at !== -1; at = body.indexOf('@', at + 1)) {
    if (!HOST_AUTHORITY.test(body.slice(at + 1))) continue
    const info = body.slice(0, at)
    const colon = info.indexOf(':')
    const user = colon < 0 ? info : info.slice(0, colon)
    if (user.includes('/') || /^[^:/]*:\d{1,5}\//.test(info)) return null
    return {
      scheme,
      user,
      password: colon < 0 ? undefined : info.slice(colon + 1),
      rest: body.slice(at + 1)
    }
  }
  return null
}

/**
 * Split what a user types or pastes into the Host field — `host`, `host:port`,
 * `user@host:port`, or a full `ftp://user:pass@host:port/path` / `ftps://…` URL —
 * into connection fields. Only the parts actually present are returned.
 */
export function parseServerAddress(input: string): ParsedServerAddress {
  const trimmed = input.trim()
  const info = splitUserinfo(trimmed)
  const text = info ? info.scheme + info.rest : trimmed
  const scheme = /^(ftps?|sftp):\/\//i.exec(text)?.[1].toLowerCase()
  let url: URL
  try {
    url = new URL(scheme ? text : `ftp://${text}`)
  } catch {
    return { host: text.replace(/\/+$/, ''), ...credentials(info) }
  }

  // IPv6 literals come back bracketed ('[::1]'); the socket wants the bare address.
  const parsed: ParsedServerAddress = { host: url.hostname.replace(/^\[(.*)\]$/, '$1') }
  // ftp:// is a WHATWG special scheme, so an explicit ':21' comes back as ''. Read it from the
  // authority ourselves, or a typed ':21' would lose to whatever the Port field held.
  const authority = text.replace(/^[a-z]+:\/\//i, '').split('/')[0]
  const explicitPort = /:(\d{1,5})$/.exec(authority)?.[1]
  if (url.port || explicitPort) parsed.port = Number(url.port || explicitPort)
  Object.assign(parsed, credentials(info))
  if (scheme === 'ftps') parsed.secure = true
  const path = safeDecode(url.pathname).replace(/\/+$/, '')
  if (path) parsed.path = path
  return parsed
}

function credentials(info: Userinfo | null): Pick<ParsedServerAddress, 'user' | 'password'> {
  return {
    ...(info?.user && { user: safeDecode(info.user) }),
    ...(info?.password && { password: safeDecode(info.password) })
  }
}

/** A server being edited. The port stays the typed string (digits only) until connect/save. */
export interface ServerDraft {
  id?: number
  name: string
  host: string
  port: string
  username: string
  password: string
  secure: boolean
  /** Start folder; '' opens the folder this server was last left in. */
  path: string
}

export const emptyDraft = (): ServerDraft => ({
  name: '',
  host: '',
  port: '21',
  username: '',
  password: '',
  secure: false,
  path: ''
})

export const toDraft = (s: FtpServer, path = ''): ServerDraft => ({
  id: s.id,
  name: s.name,
  host: s.host,
  port: String(s.port),
  username: s.username,
  password: s.password,
  secure: s.secure,
  path
})

/** The parts of a pasted address as draft fields. */
export function draftFields(p: ParsedServerAddress): Partial<ServerDraft> {
  return {
    host: p.host,
    ...(p.port !== undefined && { port: String(p.port) }),
    ...(p.user !== undefined && { username: p.user }),
    ...(p.password !== undefined && { password: p.password }),
    ...(p.secure && { secure: true }),
    ...(p.path !== undefined && { path: p.path })
  }
}

const isAnonymous = (user: string): boolean => !user.trim() || /^anonymous$/i.test(user.trim())

/** Primary label: alias, else host. */
export const serverLabel = (s: { name: string; host: string }): string =>
  s.name.trim() || s.host.trim()

/** `user@host:port`; anonymous logins leave the user out. IPv6 hosts are bracketed. */
export function serverAddress(s: {
  username: string
  host: string
  port: number | string
}): string {
  const host = s.host.trim()
  if (!host) return ''
  const user = isAnonymous(s.username) ? '' : `${s.username.trim()}@`
  return `${user}${host.includes(':') ? `[${host}]` : host}:${s.port || 21}`
}

/** True when the draft still holds exactly what is saved for `s`. */
export const sameFields = (d: ServerDraft, s: FtpServer): boolean =>
  d.name === s.name &&
  d.host === s.host &&
  (parseInt(d.port, 10) || 21) === s.port &&
  d.username === s.username &&
  d.password === s.password &&
  d.secure === s.secure

/** Every whitespace-separated token appears in the alias, host, user or port. */
export function matchServer(s: FtpServer, query: string): boolean {
  const hay = `${s.name} ${s.host} ${s.username} ${s.port}`.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => hay.includes(token))
}

/**
 * "3 hours ago" in the given locale, or null when never connected. SQLite's `datetime('now')`
 * is UTC without a zone ('2026-09-27 10:00:00'), which `Date` would read as local time.
 */
export function formatLastConnected(value: string | undefined, locale: string): string | null {
  if (!value) return null
  const time = new Date(/[zT]/i.test(value) ? value : `${value.replace(' ', 'T')}Z`).getTime()
  if (Number.isNaN(time)) return null
  const sec = (time - Date.now()) / 1000
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  // [이 단위를 쓰는 상한(초), 단위, 단위 길이(초)]
  const units: Array<[number, Intl.RelativeTimeFormatUnit, number]> = [
    [60, 'second', Infinity],
    [3600, 'minute', 60],
    [86400, 'hour', 3600],
    [604800, 'day', 86400],
    [2592000, 'week', 604800],
    [31536000, 'month', 2592000],
    [Infinity, 'year', 31536000]
  ]
  const [, unit, size] = units.find(([limit]) => Math.abs(sec) < limit)!
  return rtf.format(Math.trunc(sec / size), unit)
}

export const isValidPort = (port: number): boolean =>
  Number.isInteger(port) && port >= 1 && port <= 65535

/** Hosts compare case-insensitively: older saved rows keep their typed case ('NAS.local'). */
export const sameHost = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

export const findSaved = (
  servers: FtpServer[],
  host: string,
  port: number
): FtpServer | undefined => servers.find((s) => sameHost(s.host, host) && s.port === port)

/**
 * The fields to send for a draft, with anything still pasted into the host field split out.
 * A plain host keeps its case, so an older 'NAS.local' row still matches on (host, port).
 * An empty port means 21; anything else is kept as typed so {@link isValidPort} can reject it.
 */
export function resolveDraft(d: ServerDraft): {
  server: Omit<FtpServer, 'lastConnected'>
  path?: string
} {
  const parsed = parseServerAddress(d.host)
  return {
    server: {
      id: d.id,
      name: d.name.trim(),
      host: sameHost(parsed.host, d.host) ? d.host.trim() : parsed.host,
      port: parsed.port ?? (d.port.trim() ? Number(d.port) : 21),
      username: d.username.trim() || parsed.user || '',
      password: d.password || parsed.password || '',
      secure: d.secure || parsed.secure === true
    },
    path: parsed.path
  }
}

/** The address text with the password taken out of `user:password@`, so it never stays on screen. */
export function stripPassword(text: string): string {
  const info = splitUserinfo(text)
  if (!info || info.password === undefined) return text
  return `${info.scheme}${info.user}@${info.rest}`
}
