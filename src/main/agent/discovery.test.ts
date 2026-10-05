import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  defaultUserDataDir,
  discoverEndpoint,
  readDiscovery,
  removeDiscovery,
  writeDiscovery
} from './discovery'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ftpb-discovery-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const INFO = {
  url: 'http://127.0.0.1:47821/mcp',
  token: 'tok-1',
  pid: process.pid,
  version: '1.2.0'
}

describe('discovery files', () => {
  it('writes endpoint.json and token owner-only, reads them back and removes them', () => {
    // covers: Test-563
    writeDiscovery(dir, INFO)

    const agentDir = join(dir, 'agent')
    expect(JSON.parse(readFileSync(join(agentDir, 'endpoint.json'), 'utf8'))).toEqual({
      url: INFO.url,
      pid: INFO.pid,
      version: INFO.version
    })
    // Grok bearer_token_file·opencode {file:}가 그대로 읽는다: 토큰 원문만, 줄바꿈 없이
    expect(readFileSync(join(agentDir, 'token'), 'utf8')).toBe('tok-1')
    if (process.platform !== 'win32') {
      expect(statSync(agentDir).mode & 0o777).toBe(0o700)
      expect(statSync(join(agentDir, 'endpoint.json')).mode & 0o777).toBe(0o600)
      expect(statSync(join(agentDir, 'token')).mode & 0o777).toBe(0o600)
    }
    // 원자적 교체: 임시 파일이 남지 않는다
    expect(readdirSync(agentDir).sort()).toEqual(['endpoint.json', 'token'])
    expect(readDiscovery(dir)).toEqual({ ...INFO })

    writeDiscovery(dir, { ...INFO, token: 'tok-2' })
    expect(readDiscovery(dir)?.token).toBe('tok-2')

    removeDiscovery(dir)
    expect(existsSync(join(agentDir, 'endpoint.json'))).toBe(false)
    expect(existsSync(join(agentDir, 'token'))).toBe(false)
    expect(readDiscovery(dir)).toBeNull()
    expect(() => removeDiscovery(dir)).not.toThrow()
  })

  it("leaves another running instance's files alone", () => {
    // covers: Test-563
    writeDiscovery(dir, { ...INFO, pid: process.pid + 1 })

    removeDiscovery(dir)

    expect(readDiscovery(dir)?.url).toBe(INFO.url)
  })

  it('reads null when a file is missing or malformed', () => {
    // covers: Test-563
    expect(readDiscovery(dir)).toBeNull()
    writeDiscovery(dir, INFO)
    writeFileSync(join(dir, 'agent', 'endpoint.json'), '{not json')
    expect(readDiscovery(dir)).toBeNull()
  })
})

describe('defaultUserDataDir', () => {
  it("resolves Electron's userData folder for the app name on each OS", () => {
    // covers: Test-564
    // 패키징된 package.json에는 productName이 없어 Electron 앱 이름이 name(`ftp-browser`)이 된다.
    // Linux에서 electron-builder --dir 산출물과 out/ 빌드를 새 HOME으로 띄워 확인했다.
    expect(defaultUserDataDir('linux', {}, '/home/u')).toBe('/home/u/.config/ftp-browser')
    expect(defaultUserDataDir('linux', { XDG_CONFIG_HOME: '/x/cfg' }, '/home/u')).toBe(
      '/x/cfg/ftp-browser'
    )
    expect(defaultUserDataDir('darwin', {}, '/Users/u')).toBe(
      '/Users/u/Library/Application Support/ftp-browser'
    )
    expect(
      defaultUserDataDir('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u')
    ).toBe('C:\\Users\\u\\AppData\\Roaming\\ftp-browser')
    expect(defaultUserDataDir('win32', {}, 'C:\\Users\\u')).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\ftp-browser'
    )
  })
})

describe('discoverEndpoint', () => {
  it('prefers FTPB_URL and FTPB_TOKEN, else reads the userData discovery files', () => {
    // covers: Test-550
    const home = dir
    const userData = defaultUserDataDir('linux', {}, home)
    expect(discoverEndpoint('linux', {}, home)).toBeNull()

    writeDiscovery(userData, INFO)
    expect(discoverEndpoint('linux', {}, home)).toMatchObject({ url: INFO.url, token: 'tok-1' })
    expect(
      discoverEndpoint('linux', { FTPB_URL: 'http://127.0.0.1:1/mcp', FTPB_TOKEN: 'env' }, home)
    ).toMatchObject({ url: 'http://127.0.0.1:1/mcp', token: 'env' })
    expect(discoverEndpoint('linux', { FTPB_TOKEN: 'env' }, home)).toMatchObject({
      url: INFO.url,
      token: 'env'
    })

    removeDiscovery(userData)
    expect(
      discoverEndpoint('linux', { FTPB_URL: 'http://127.0.0.1:1/mcp', FTPB_TOKEN: 'env' }, home)
    ).toMatchObject({ url: 'http://127.0.0.1:1/mcp', token: 'env' })
    expect(discoverEndpoint('linux', { FTPB_URL: 'http://127.0.0.1:1/mcp' }, home)).toBeNull()
  })
})
