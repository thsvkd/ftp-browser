import { describe, it, expect } from 'vitest'
import { agentFolderPath, isInsideFolder } from './paths'

describe('isInsideFolder', () => {
  it('compares normalized absolute paths, ignoring case only on Windows', () => {
    // covers: Test-612
    const posix: Array<[string, string, boolean]> = [
      ['/home/me/Downloads', '/home/me/Downloads', true],
      ['/home/me/Downloads', '/home/me/Downloads/', true],
      ['/home/me/Downloads/', '/home/me/Downloads/a/b.jpg', true],
      ['/home/me/Downloads', '/home/me/Downloads/./a//b', true],
      ['/home/me/Downloads', '/home/me/Downloads/../.config/autostart', false],
      ['/home/me/Downloads', '/home/me/Downloads-evil/x', false],
      ['/home/me/Downloads', '/home/me', false],
      ['/home/me/Downloads', '/home/me/downloads/x', false],
      ['/', '/etc/passwd', true]
    ]
    for (const [root, target, inside] of posix) {
      expect(isInsideFolder(root, target, 'linux'), `${root} ${target}`).toBe(inside)
    }
    const win32: Array<[string, string, boolean]> = [
      ['C:\\Users\\Me\\Downloads', 'c:\\users\\me\\downloads\\a.jpg', true],
      ['C:\\Users\\Me\\Downloads', 'C:/Users/Me/Downloads/sub/a.jpg', true],
      ['C:\\Users\\Me\\Downloads\\', 'C:\\Users\\Me\\DOWNLOADS', true],
      ['C:\\Users\\Me\\Downloads', 'C:\\Users\\Me\\Downloads\\..\\AppData\\Roaming', false],
      ['C:\\Users\\Me\\Downloads', 'C:\\Users\\Me\\Downloads2\\a.jpg', false],
      ['C:\\Users\\Me\\Downloads', 'D:\\Users\\Me\\Downloads\\a.jpg', false],
      ['C:\\', 'c:\\Windows', true]
    ]
    for (const [root, target, inside] of win32) {
      expect(isInsideFolder(root, target, 'win32'), `${root} ${target}`).toBe(inside)
    }
  })
})

describe('agentFolderPath', () => {
  it('keeps a downloads folder that is neither home, above home nor a filesystem root', () => {
    // covers: Test-660
    const kept: Array<[string, string, string]> = [
      ['/home/me/Downloads', '/home/me', 'linux'],
      ['/home/me/Desktop', '/home/me', 'linux'],
      ['/mnt/data/dl', '/home/me', 'linux'],
      ['/home/me-old', '/home/me', 'linux'],
      ['/Users/me/Downloads', '/Users/me', 'darwin'],
      ['C:\\Users\\Me\\Downloads', 'C:\\Users\\Me', 'win32'],
      ['D:\\Downloads', 'C:\\Users\\Me', 'win32']
    ]
    for (const [downloads, home, platform] of kept) {
      expect(agentFolderPath(downloads, home, platform), downloads).toBe(downloads)
    }
  })

  it('falls back to <home>/Downloads when the downloads path is home itself', () => {
    // covers: Test-661
    // Electron on Linux without user-dirs.dirs returns $HOME for 'downloads' (b12e936 E2E).
    expect(agentFolderPath('/home/me', '/home/me', 'linux')).toBe('/home/me/Downloads')
    expect(agentFolderPath('/home/me/', '/home/me', 'linux')).toBe('/home/me/Downloads')
    expect(agentFolderPath('/home/me/./', '/home/me', 'linux')).toBe('/home/me/Downloads')
    expect(agentFolderPath('/Users/Me', '/Users/me', 'darwin')).toBe('/Users/me/Downloads')
    expect(agentFolderPath('c:/users/me', 'C:\\Users\\Me', 'win32')).toBe(
      'C:\\Users\\Me\\Downloads'
    )
  })

  it('falls back to <home>/Downloads when the downloads path is above home or a filesystem root', () => {
    // covers: Test-662
    const fallback: Array<[string, string, string, string]> = [
      ['/home', '/home/me', 'linux', '/home/me/Downloads'],
      ['/', '/home/me', 'linux', '/home/me/Downloads'],
      ['//', '/home/me', 'linux', '/home/me/Downloads'],
      ['/', '/Users/me', 'darwin', '/Users/me/Downloads'],
      ['/users', '/Users/me', 'darwin', '/Users/me/Downloads'],
      ['C:\\Users', 'C:\\Users\\Me', 'win32', 'C:\\Users\\Me\\Downloads'],
      ['C:\\', 'C:\\Users\\Me', 'win32', 'C:\\Users\\Me\\Downloads'],
      ['D:\\', 'C:\\Users\\Me', 'win32', 'C:\\Users\\Me\\Downloads'],
      ['\\\\nas\\share\\', 'C:\\Users\\Me', 'win32', 'C:\\Users\\Me\\Downloads']
    ]
    for (const [downloads, home, platform, expected] of fallback) {
      expect(agentFolderPath(downloads, home, platform), downloads).toBe(expected)
    }
  })
})
